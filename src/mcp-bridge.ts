/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

/**
 * @brief File-based IPC bridge between the VS Code extension and the MCP server.
 *
 * The extension (running inside the extension host process) and the MCP server
 * (running as a separate stdio-based Node.js process) communicate through JSON
 * files stored in the `ipc/` subdirectory of the extension's workspaceStorage
 * (`context.storageUri`). The absolute path is passed to the MCP server via the
 * `OPENBLINK_IPC_DIR` environment variable so the two processes share the same
 * directory without polluting the user's workspace tree.
 *
 *   - `status.json`  — Written by the extension (throttled) on connection
 *                       state changes and build completions.
 *   - `openblink-console.log` — Written by the extension (throttled) with
 *                       the most recent device console output (up to 100 lines).
 *   - `build-status.json` — Written by the extension on build lifecycle changes.
 *   - `build-diagnostics.json` — Written by the extension after each build.
 *   - `trigger.json` — Written by the MCP server to request a Build & Blink.
 *   - `result.json`  — Written by the extension after a triggered build
 *                       completes so the MCP server can return the outcome.
 *   - `command.json` / `command-result.json` — MCP server ↔ extension
 *                       commands (scan, connect, disconnect, reset, validate, cancel).
 *
 * All write operations are guarded by the `openblink.mcp.enabled` setting.
 * When the setting is `false`, no files are written and the watchers for
 * `trigger.json` / `command.json` are disposed.
 *
 * Design notes:
 *   1. **Atomic writes**: all writes go through a temp file + `rename` so that
 *      the MCP server never reads a partially-written JSON file.
 *   2. **Throttling (not debouncing)**: the previous implementation used pure
 *      debounce for console output, which meant that a chatty device that
 *      prints logs faster than the debounce interval would *never* flush the
 *      buffer (every new log reset the timer).  The throttler below guarantees
 *      at-least-once flushing per interval even under a steady event stream.
 *   3. **Fallback watchers**: VS Code's `FileSystemWatcher` occasionally fails
 *      to notice writes to paths outside the workspace (e.g. workspaceStorage).
 *      We therefore pair each VS Code watcher with a Node `fs.watch` so that
 *      at least one of them delivers the event.
 *   4. **Error logging**: previously all I/O errors were silently swallowed.
 *      They are now logged to the `[MCP]` output channel for diagnosis.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionState, MetricsData, MetricsStats, getMcpStatusDebounce, getMcpConsoleDebounce } from './types';
import { getConsoleLog, log } from './ui-manager';

// ============================================================================
// Command Types
// ============================================================================

/** @brief Supported command types for device operations */
export type McpCommandType = 'scan' | 'connect' | 'disconnect' | 'reset' | 'cancel' | 'validate';

/** @brief Shape of the `command.json` file for device operations */
export interface McpCommand {
  /** @brief Command type */
  type: McpCommandType;
  /** @brief Unique request identifier */
  requestId: string;
  /** @brief Target request ID for cancel commands */
  targetRequestId?: string;
  /** @brief Device ID for connect commands */
  deviceId?: string;
  /** @brief Timeout in milliseconds */
  timeout?: number;
  /** @brief Force flag for disconnect commands */
  force?: boolean;
  /** @brief Program slot for reset commands */
  slot?: number;
  /** @brief File path for validate commands */
  file?: string;
  /** @brief Source code for validate commands */
  code?: string;
  /** @brief ISO 8601 timestamp */
  timestamp: string;
}

/** @brief Shape of the `command-result.json` file */
export interface McpCommandResult {
  /** @brief Unique request identifier matching the command */
  requestId: string;
  /** @brief Whether the command succeeded */
  success: boolean;
  /** @brief Discovered devices for scan commands */
  devices?: Array<{ id: string; name: string; rssi?: number }>;
  /** @brief Device name for connect commands */
  deviceName?: string;
  /** @brief Negotiated MTU for connect commands */
  mtu?: number;
  /** @brief Human-readable error message on failure */
  error?: string;
}

/** @brief Shape of the `build-diagnostics.json` file */
export interface McpBuildDiagnostics {
  /** @brief ISO 8601 timestamp of the build */
  timestamp: string;
  /** @brief Source file path */
  file: string;
  /** @brief Whether the build succeeded */
  success: boolean;
  /** @brief Error details */
  errors: Array<{
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
    code?: string;
  }>;
  /** @brief Suggested fixes */
  suggestions?: string[];
}

/** @brief Shape of the `build-status.json` file */
export interface McpBuildStatus {
  /** @brief Whether a build is currently in progress */
  isBuilding: boolean;
  /** @brief Information about the last build */
  lastBuild: {
    requestId: string;
    success: boolean;
    timestamp: string;
    file: string;
  } | null;
  /** @brief Number of pending builds in queue */
  queueLength: number;
}

// ============================================================================
// Directory & File Paths
// ============================================================================

/** @brief Name of the IPC subdirectory created inside the extension workspaceStorage. */
const IPC_DIR = 'ipc';

/**
 * @brief Absolute path to the IPC directory, resolved during {@link initialize}.
 *
 * Computed as `<context.storageUri.fsPath>/ipc`.  When VS Code is launched
 * without a workspace, `context.storageUri` is `undefined` and this stays
 * `undefined`, which disables all IPC file operations.
 */
let ipcDirPath: string | undefined;

/** @brief Resolve the absolute path to the IPC directory. */
function ipcDir(): string | undefined {
  return ipcDirPath;
}

/** @brief Ensure the IPC directory exists (sync; called from hot paths). */
function ensureDir(): string | undefined {
  const dir = ipcDir();
  if (!dir) { return undefined; }
  try {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    return dir;
  } catch (err) {
    log(`[MCP] ensureDir failed: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * @brief Resolve the IPC directory path for the given extension context.
 *
 * Exported so callers (e.g. the MCP Server Definition Provider) can pass the
 * same path to the MCP server via the `OPENBLINK_IPC_DIR` environment variable.
 *
 * @param context  Extension context supplying `storageUri`.
 * @returns Absolute path to the IPC directory, or `undefined` if no
 *          workspaceStorage is available (e.g. no workspace is open).
 */
export function resolveIpcDir(context: vscode.ExtensionContext): string | undefined {
  const storageFsPath = context.storageUri?.fsPath;
  return storageFsPath ? path.join(storageFsPath, IPC_DIR) : undefined;
}

// ============================================================================
// Atomic I/O Helpers
// ============================================================================

/** @brief Monotonic counter to ensure unique tmp paths even within the same millisecond. */
let tmpCounter = 0;

/** @brief Extract a human-readable error message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @brief Atomically write a JSON file using a temp file + rename.
 *
 * The MCP server polls result files and reads them with `JSON.parse`.
 * A non-atomic write can be observed partially, producing a parse error
 * that the server silently swallows (returning `null`) and eventually
 * times out.  Using `rename` — which is atomic on the same filesystem —
 * guarantees that the reader either sees the old file or the fully
 * written new one.
 *
 * @param filePath  Destination path.
 * @param data      Serializable payload.
 * @throws {Error} Write or rename failure (tmp file is best-effort removed).
 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
}

/** @brief Atomically write a text file using a temp file + rename. */
async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`;
  try {
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
}

// ============================================================================
// Throttler (at-least-once flush per interval)
// ============================================================================

/**
 * @brief Throttler handle.
 *
 * `schedule()` marks the state as dirty and ensures a flush will run
 * within `getInterval()` ms.  Unlike `setTimeout`-based debounce, calling
 * `schedule()` again before the pending timer fires does **not** reset it.
 * This prevents starvation under a steady event stream (e.g. a device
 * printing console output every 100 ms would otherwise never flush with
 * a 2-second debounce).
 */
interface Throttler {
  /** @brief Mark state as dirty and ensure a flush runs within the configured interval. */
  schedule(): void;
  /** @brief Cancel any pending timer and flush immediately. */
  flushNow(): Promise<void>;
  /** @brief Cancel pending work and prevent further scheduling. */
  dispose(): void;
}

/**
 * @brief Create a throttler that guarantees at-least-once flushing.
 *
 * Semantics:
 *   - After the first `schedule()` call, a single timer is armed for
 *     `getInterval()` ms.  Subsequent calls before the timer fires are
 *     coalesced (no-op).
 *   - If a new `schedule()` arrives *during* an active flush, a single
 *     trailing flush is queued; multiple arrivals collapse into one.
 *   - Errors inside the flusher are logged (not rethrown) and the state
 *     stays "dirty" so the next `schedule()` will retry.
 *
 * @param flusher      Async function that performs the actual work.
 * @param getInterval  Returns the minimum interval between flushes (ms).
 * @param label        Short label used in error log messages.
 */
function createThrottler(
  flusher: () => Promise<void>,
  getInterval: () => number,
  label: string,
): Throttler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const scheduleTimer = () => {
    if (disposed || timer !== undefined) { return; }
    const delay = Math.max(0, getInterval());
    timer = setTimeout(() => { void runFlush(); }, delay);
  };

  const runFlush = async () => {
    timer = undefined;
    if (disposed) { return; }
    if (inFlight) { pending = true; return; }
    inFlight = true;
    try {
      await flusher();
    } catch (err) {
      log(`[MCP] ${label} flush error: ${errorMessage(err)}`);
    } finally {
      inFlight = false;
      if (!disposed && pending) {
        pending = false;
        scheduleTimer();
      }
    }
  };

  return {
    schedule: () => {
      if (disposed) { return; }
      if (inFlight) { pending = true; return; }
      scheduleTimer();
    },
    flushNow: async () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      await runFlush();
    },
    dispose: () => {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      pending = false;
    },
  };
}

// ============================================================================
// Fallback File Watcher (VS Code + fs.watch)
// ============================================================================

/** @brief Composite watcher that fires when either VS Code or `fs.watch` detects a change. */
interface FallbackWatcher {
  dispose(): void;
}

/**
 * @brief Create a file watcher that uses both VS Code's `FileSystemWatcher`
 *        and Node's `fs.watch` in parallel.
 *
 * VS Code's FileSystemWatcher reliably covers paths inside the workspace
 * but can miss events on paths outside it (the IPC directory lives under
 * `workspaceStorage`, which is *not* in the workspace).  `fs.watch`
 * complements this but has its own platform quirks (Linux inotify limits,
 * macOS FSEvents coalescing).  Running both gives us maximum reach; the
 * event handler must be idempotent (our consume-then-unlink pattern is).
 *
 * @param dir       Absolute directory to watch.
 * @param filename  Exact filename to trigger on.
 * @param onEvent   Callback invoked on create/change.  May be called
 *                  multiple times for a single logical event; handler
 *                  must be idempotent.
 */
function createFallbackWatcher(
  dir: string,
  filename: string,
  onEvent: () => void,
): FallbackWatcher {
  let vsWatcher: vscode.FileSystemWatcher | undefined;
  let fsWatcher: fs.FSWatcher | undefined;

  try {
    const pattern = new vscode.RelativePattern(dir, filename);
    vsWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
    vsWatcher.onDidCreate(onEvent);
    vsWatcher.onDidChange(onEvent);
  } catch (err) {
    log(`[MCP] VS Code watcher failed for ${filename}: ${errorMessage(err)}`);
  }

  try {
    fsWatcher = fs.watch(dir, { persistent: false }, (eventType, changed) => {
      if (!changed) { return; }
      if (changed === filename && (eventType === 'rename' || eventType === 'change')) {
        onEvent();
      }
    });
    fsWatcher.on('error', (err) => {
      log(`[MCP] fs.watch error for ${filename}: ${errorMessage(err)}`);
    });
  } catch (err) {
    log(`[MCP] fs.watch setup failed for ${filename}: ${errorMessage(err)}`);
  }

  return {
    dispose: () => {
      try { vsWatcher?.dispose(); } catch { /* ignore */ }
      try { fsWatcher?.close(); } catch { /* ignore */ }
    },
  };
}

// ============================================================================
// Enabled State
// ============================================================================

/** @brief Current enabled state, mirroring `openblink.mcp.enabled`. */
let enabled = true;

/** @brief Fallback watcher (VS Code + fs.watch) for `trigger.json`. */
let triggerWatcher: FallbackWatcher | undefined;

/** @brief Fallback watcher (VS Code + fs.watch) for `command.json`. */
let commandWatcher: FallbackWatcher | undefined;

/** @brief Callback invoked when a build trigger is detected. */
let onTriggerCallback: ((filePath: string, requestId: string) => Promise<void>) | undefined;

/** @brief Callback invoked when a device command is detected. */
let onCommandCallback: ((command: McpCommand) => Promise<void>) | undefined;

// ============================================================================
// Write Callbacks (for UI notification)
// ============================================================================

/** @brief Callback type for IPC file write notifications. */
type WriteCallback = () => void;

/** @brief Callback invoked after a successful `status.json` write. */
let onStatusWrittenCallback: WriteCallback | undefined;

/** @brief Callback invoked after a successful `openblink-console.log` write. */
let onConsoleWrittenCallback: WriteCallback | undefined;

/**
 * @brief Register callbacks invoked after IPC file writes.
 *
 * These callbacks allow the extension host (e.g. {@link McpStatusTreeProvider})
 * to update the UI whenever the bridge writes an IPC file.
 *
 * @param opts  Object with optional `onStatusWritten` and `onConsoleWritten` callbacks.
 */
export function setWriteCallbacks(opts: {
  onStatusWritten?: WriteCallback;
  onConsoleWritten?: WriteCallback;
}): void {
  onStatusWrittenCallback = opts.onStatusWritten;
  onConsoleWrittenCallback = opts.onConsoleWritten;
}

/**
 * @brief Check whether MCP IPC is currently enabled.
 * @returns `true` if the `openblink.mcp.enabled` setting is `true`.
 */
export function isEnabled(): boolean {
  return enabled;
}

/**
 * @brief Update the enabled state.
 *
 * When transitioning from enabled → disabled, the trigger watcher is disposed.
 * Existing IPC files are left on disk (they become stale but harmless).
 * When transitioning from disabled → enabled, the IPC directory and trigger
 * watcher are re-created.
 *
 * @param value  New enabled state.
 */
export function setEnabled(value: boolean): void {
  const wasEnabled = enabled;
  enabled = value;

  if (wasEnabled && !enabled) {
    // Disable: dispose watchers.  Throttlers are left alive so state
    // transitions during the disabled window are not lost; their
    // `flusher` checks `enabled` and no-ops when disabled.
    triggerWatcher?.dispose();
    triggerWatcher = undefined;
    commandWatcher?.dispose();
    commandWatcher = undefined;
  } else if (!wasEnabled && enabled) {
    // Re-enable: bring up watchers and seed the status file so the MCP
    // server has a fresh snapshot to read.
    startTriggerWatcher();
    startCommandWatcher();
    statusThrottler.schedule();
    flushBuildStatus();
  }
}

// ============================================================================
// Status File (throttled)
// ============================================================================

/**
 * @brief Shape of the `status.json` file written to the IPC directory.
 */
export interface McpStatus {
  /** @brief BLE connection state and device details. */
  connection: {
    /** @brief Current connection state. */
    state: ConnectionState;
    /** @brief Advertised local name of the connected device, or null. */
    deviceName: string | null;
    /** @brief Noble peripheral identifier of the connected device, or null. */
    deviceId: string | null;
    /** @brief Negotiated BLE MTU in bytes. */
    mtu: number;
  };
  /** @brief Latest and aggregate build/transfer metrics. */
  metrics: {
    /** @brief Values from the most recent build cycle. */
    latest: MetricsData;
    /** @brief Rolling min/avg/max statistics. */
    stats: {
      compile: MetricsStats;
      transfer: MetricsStats;
      size: MetricsStats;
    };
  };
  /** @brief Currently selected board, or null if none is selected. */
  board: {
    /** @brief Internal board identifier (e.g. "m5stamps3"). */
    name: string;
    /** @brief Human-readable board name shown in the UI. */
    displayName: string;
    /** @brief Absolute filesystem path to the board's reference Markdown file. */
    referencePath: string;
  } | null;
  /** @brief Workspace-relative path of the Ruby source file to compile. */
  sourceFile: string;
  /** @brief Active program slot on the target device (1 or 2). */
  slot: number;
  /** @brief Result of the most recent build, or null if no build has occurred. */
  lastBuild: {
    /** @brief Whether the build succeeded. */
    success: boolean;
    /** @brief ISO 8601 timestamp of the build completion. */
    timestamp: string;
    /** @brief Error message if the build failed. */
    error?: string;
  } | null;
}

/** @brief Cached status object, updated incrementally. */
const currentStatus: McpStatus = {
  connection: { state: 'disconnected', deviceName: null, deviceId: null, mtu: 20 },
  metrics: {
    latest: {},
    stats: {
      compile: { min: null, avg: null, max: null },
      transfer: { min: null, avg: null, max: null },
      size: { min: null, avg: null, max: null },
    },
  },
  board: null,
  sourceFile: 'app.rb',
  slot: 2,
  lastBuild: null,
};

/** @brief Throttler for status.json writes (interval = openblink.mcp.statusDebounce). */
const statusThrottler: Throttler = createThrottler(
  async () => { await flushStatus(); },
  getMcpStatusDebounce,
  'status',
);

/**
 * @brief Merge partial updates into the current status and schedule a throttled write.
 * @param patch  Partial status fields to merge.
 */
export function updateStatus(patch: Partial<McpStatus>): void {
  if (!enabled) { return; }
  // NOTE: shallow merge — only use with top-level primitive fields.
  // For nested objects (connection, metrics, board), use the dedicated update functions.
  Object.assign(currentStatus, patch);
  statusThrottler.schedule();
}

/**
 * @brief Update the connection-related fields of the status.
 */
export function updateConnectionStatus(
  state: ConnectionState,
  deviceName: string | null,
  deviceId: string | null,
  mtu: number,
): void {
  if (!enabled) { return; }
  currentStatus.connection = { state, deviceName, deviceId, mtu };
  statusThrottler.schedule();
}

/**
 * @brief Update the metrics fields of the status.
 */
export function updateMetricsStatus(latest: MetricsData, stats: { compile: MetricsStats; transfer: MetricsStats; size: MetricsStats }): void {
  if (!enabled) { return; }
  currentStatus.metrics = { latest, stats };
  statusThrottler.schedule();
}

/**
 * @brief Update the board field of the status.
 */
export function updateBoardStatus(board: { name: string; displayName: string; referencePath: string } | null): void {
  if (!enabled) { return; }
  currentStatus.board = board;
  statusThrottler.schedule();
}

/**
 * @brief Update the last build result field of the status.
 */
export function updateBuildResult(success: boolean, error?: string): void {
  if (!enabled) { return; }
  currentStatus.lastBuild = { success, timestamp: new Date().toISOString(), error };
  statusThrottler.schedule();
}

/** @brief Atomically write the current status to `status.json`. */
async function flushStatus(): Promise<void> {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  await writeJsonAtomic(path.join(dir, 'status.json'), currentStatus);
  onStatusWrittenCallback?.();
}

// ============================================================================
// Console Log File (throttled)
// ============================================================================

/** @brief Snapshot of the last-written console buffer, used to skip no-op flushes. */
let lastConsoleSignature = '';

/**
 * @brief Throttler for `openblink-console.log` writes.
 *
 * **Bug fix**: the previous pure-debounce implementation would reset the
 * timer on every new line from the device, so a program that prints logs
 * faster than `openblink.mcp.consoleDebounce` (default 2 s) never produced
 * a written file — the MCP client saw no updates at all.  A throttler
 * ensures the buffer is flushed at least once per interval while still
 * coalescing bursty input.
 */
const consoleThrottler: Throttler = createThrottler(
  async () => { await flushConsole(); },
  getMcpConsoleDebounce,
  'console',
);

/**
 * @brief Schedule a throttled write of the console ring buffer.
 *
 * Called from the extension whenever new console output is received.
 * The actual file write is batched over the `openblink.mcp.consoleDebounce`
 * window; multiple calls within that window coalesce into a single write.
 */
export function scheduleConsoleWrite(): void {
  if (!enabled) { return; }
  consoleThrottler.schedule();
}

/** @brief Atomically write the current console buffer to `openblink-console.log`. */
async function flushConsole(): Promise<void> {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  const lines = getConsoleLog();
  const body = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  // Skip the write if the buffer content hasn't changed since the last flush.
  // The console ring buffer is small (≤100 lines by default), so the hash
  // cost is negligible compared to a filesystem write.
  if (body === lastConsoleSignature) { return; }
  await writeTextAtomic(path.join(dir, 'openblink-console.log'), body);
  lastConsoleSignature = body;
  onConsoleWrittenCallback?.();
}

// ============================================================================
// Build Result File (atomic, immediate)
// ============================================================================

/**
 * @brief Shape of the `result.json` file written after a triggered build.
 */
export interface McpBuildResult {
  /** @brief Unique request identifier matching the trigger that initiated this build. */
  requestId: string;
  /** @brief Whether the build and transfer succeeded. */
  success: boolean;
  /** @brief Compilation wall-clock time in milliseconds (present on success). */
  compileTime?: number;
  /** @brief BLE transfer wall-clock time in milliseconds (present on success with device). */
  transferTime?: number;
  /** @brief Compiled program size in bytes (present on success). */
  programSize?: number;
  /** @brief Human-readable error message (present on failure). */
  error?: string;
  /** @brief True when compilation succeeded but no device was connected for transfer. */
  compiledWithoutTransfer?: boolean;
}

/**
 * @brief Write a build result file for the MCP server to consume.
 *
 * Fire-and-forget: the returned promise resolves immediately; the actual
 * atomic write completes in the background.  Write failures are logged
 * to the output channel rather than thrown, matching the legacy behaviour
 * while giving operators a diagnostic trail.
 *
 * @param result  Build outcome.
 */
export function writeBuildResult(result: McpBuildResult): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  void (async () => {
    try {
      await writeJsonAtomic(path.join(dir, 'result.json'), result);
      log(`[MCP] Build result written: ${result.success ? 'Success' : 'Failed'}${result.error ? ` (${result.error})` : ''}`);
    } catch (err) {
      log(`[MCP] writeBuildResult failed: ${errorMessage(err)}`);
    }
  })();
}

// ============================================================================
// Trigger Watcher
// ============================================================================

/**
 * @brief Shape of the `trigger.json` file written by the MCP server.
 */
export interface McpBuildTrigger {
  /** @brief Workspace-relative path of the .rb file to compile (defaults to openblink.sourceFile setting). */
  file?: string;
  /** @brief Unique request identifier used to correlate the trigger with its result. */
  requestId: string;
}

/**
 * @brief Register the callback that is invoked when `trigger.json` is detected.
 * @param callback  Async function receiving the resolved file path and request ID.
 */
export function onBuildTrigger(callback: (filePath: string, requestId: string) => Promise<void>): void {
  onTriggerCallback = callback;
}

/**
 * @brief Register the callback that is invoked when `command.json` is detected.
 * @param callback  Async function receiving the parsed command object.
 */
export function onCommand(callback: (command: McpCommand) => Promise<void>): void {
  onCommandCallback = callback;
}

/**
 * @brief Start watching for `trigger.json` in the IPC directory.
 *
 * Uses {@link createFallbackWatcher} to combine VS Code's
 * `FileSystemWatcher` with Node's `fs.watch` — the former may miss events
 * on workspaceStorage paths (outside the workspace), so the latter
 * provides a redundant signal.  Both share the same idempotent handler:
 * read the trigger, remove it, and invoke the registered callback.
 */
function startTriggerWatcher(): void {
  if (triggerWatcher) { return; }
  const dir = ipcDir();
  if (!dir) { return; }

  ensureDir();
  const triggerPath = path.join(dir, 'trigger.json');

  const handleTrigger = async () => {
    try {
      // Best-effort consume: read the file and then remove it. If a concurrent
      // onDidCreate/onDidChange handler already consumed it, one of these calls
      // throws and we silently skip, avoiding an explicit existsSync TOCTOU check.
      let raw: string;
      try {
        raw = fs.readFileSync(triggerPath, 'utf-8');
        fs.unlinkSync(triggerPath);
      } catch {
        return; // File already consumed or does not exist
      }
      let trigger: McpBuildTrigger;
      try {
        trigger = JSON.parse(raw);
      } catch (err) {
        log(`[MCP] Ignoring malformed trigger.json: ${errorMessage(err)}`);
        return;
      }
      if (!trigger.requestId || typeof trigger.requestId !== 'string') {
        log('[MCP] Ignoring trigger.json without requestId');
        return;
      }
      if (onTriggerCallback) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        const sourceFile = trigger.file
          ?? vscode.workspace.getConfiguration('openblink').get<string>('sourceFile')
          ?? 'app.rb';
        const filePath = ws ? path.join(ws.uri.fsPath, sourceFile) : sourceFile;
        // Guard against path traversal: resolved path must be inside the workspace tree.
        // Uses path.relative to avoid platform-specific casing/separator issues with startsWith.
        if (ws) {
          const resolvedFile = path.resolve(filePath);
          const resolvedWsRoot = path.resolve(ws.uri.fsPath);
          const rel = path.relative(resolvedWsRoot, resolvedFile);
          if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
            log(`[MCP] Rejecting trigger with out-of-workspace path: ${trigger.file}`);
            return;
          }
        }
        await onTriggerCallback(filePath, trigger.requestId);
      }
    } catch (err) {
      log(`[MCP] handleTrigger error: ${errorMessage(err)}`);
    }
  };

  triggerWatcher = createFallbackWatcher(dir, 'trigger.json', () => { void handleTrigger(); });

  // Process any trigger.json that was written before the watcher started
  if (fs.existsSync(triggerPath)) {
    void handleTrigger();
  }
}

// ----------------------------------------------------------------------------
// Command Watcher
// ----------------------------------------------------------------------------

/**
 * @brief Start watching for `command.json` in the IPC directory.
 *
 * Mirrors {@link startTriggerWatcher} but for device commands.  Uses the
 * same fallback-watcher strategy and idempotent consume-then-unlink
 * handler.
 */
function startCommandWatcher(): void {
  if (commandWatcher) { return; }
  const dir = ipcDir();
  if (!dir) { return; }

  ensureDir();
  const commandPath = path.join(dir, 'command.json');

  const handleCommand = async () => {
    try {
      let raw: string;
      try {
        raw = fs.readFileSync(commandPath, 'utf-8');
        fs.unlinkSync(commandPath);
      } catch {
        return; // File already consumed or does not exist
      }
      let command: McpCommand;
      try {
        command = JSON.parse(raw);
      } catch (err) {
        log(`[MCP] Ignoring malformed command.json: ${errorMessage(err)}`);
        return;
      }
      if (!command.requestId || typeof command.requestId !== 'string') {
        log('[MCP] Ignoring command.json without requestId');
        return;
      }
      if (onCommandCallback) {
        await onCommandCallback(command);
      }
    } catch (err) {
      log(`[MCP] handleCommand error: ${errorMessage(err)}`);
    }
  };

  commandWatcher = createFallbackWatcher(dir, 'command.json', () => { void handleCommand(); });

  // Process any command.json that was written before the watcher started
  if (fs.existsSync(commandPath)) {
    void handleCommand();
  }
}

// ----------------------------------------------------------------------------
// Command Result File
// ----------------------------------------------------------------------------

/**
 * @brief Write a command result file for the MCP server to consume.
 *
 * Fire-and-forget; errors are logged.
 *
 * @param result  Command outcome.
 */
export function writeCommandResult(result: McpCommandResult): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  void (async () => {
    try {
      await writeJsonAtomic(path.join(dir, 'command-result.json'), result);
    } catch (err) {
      log(`[MCP] writeCommandResult failed: ${errorMessage(err)}`);
    }
  })();
}

// ----------------------------------------------------------------------------
// Build Diagnostics File
// ----------------------------------------------------------------------------

/**
 * @brief Write build diagnostic information for the MCP server.
 *
 * Fire-and-forget; errors are logged.
 *
 * @param diagnostics  Build diagnostic data.
 */
export function writeBuildDiagnostics(diagnostics: McpBuildDiagnostics): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  void (async () => {
    try {
      await writeJsonAtomic(path.join(dir, 'build-diagnostics.json'), diagnostics);
      log(`[MCP] Build diagnostics written: ${diagnostics.errors.length} issue(s)`);
    } catch (err) {
      log(`[MCP] writeBuildDiagnostics failed: ${errorMessage(err)}`);
    }
  })();
}

// ----------------------------------------------------------------------------
// Build Status File
// ----------------------------------------------------------------------------

/** @brief Current build status */
let currentBuildStatus: McpBuildStatus = {
  isBuilding: false,
  lastBuild: null,
  queueLength: 0,
};

/**
 * @brief Update the build status.
 * @param status  Partial build status update.
 */
export function updateBuildStatus(status: Partial<McpBuildStatus>): void {
  if (!enabled) { return; }
  currentBuildStatus = { ...currentBuildStatus, ...status };
  flushBuildStatus();
}

/**
 * @brief Atomically write the current build status to `build-status.json`.
 *
 * Fire-and-forget; errors are logged.  Uses a fresh closure over the
 * current status snapshot so concurrent updates see a consistent write.
 */
function flushBuildStatus(): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  const snapshot = { ...currentBuildStatus };
  void (async () => {
    try {
      await writeJsonAtomic(path.join(dir, 'build-status.json'), snapshot);
    } catch (err) {
      log(`[MCP] flushBuildStatus failed: ${errorMessage(err)}`);
    }
  })();
}

/**
 * @brief Mark build as started.
 * @param requestId  Build request ID.
 * @param file  Source file path.
 */
export function markBuildStarted(requestId: string, file: string): void {
  updateBuildStatus({
    isBuilding: true,
    lastBuild: {
      requestId,
      success: false,
      timestamp: new Date().toISOString(),
      file,
    },
  });
}

/**
 * @brief Mark build as completed.
 * @param requestId  Build request ID.
 * @param success  Whether the build succeeded.
 */
export function markBuildCompleted(requestId: string, success: boolean): void {
  const lastBuild = currentBuildStatus.lastBuild;
  updateBuildStatus({
    isBuilding: false,
    lastBuild: lastBuild && lastBuild.requestId === requestId
      ? { ...lastBuild, success }
      : lastBuild,
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * @brief Initialize the MCP bridge.
 *
 * Resolves the IPC directory under the extension's workspaceStorage
 * (`context.storageUri/ipc`), reads the `openblink.mcp.enabled` setting,
 * creates the IPC directory if needed, and starts the trigger watcher if
 * MCP is enabled.
 *
 * @param context  The extension context for registering disposables.
 */
export function initialize(context: vscode.ExtensionContext): void {
  ipcDirPath = resolveIpcDir(context);
  enabled = vscode.workspace.getConfiguration('openblink').get<boolean>('mcp.enabled', true);

  // Read initial config values
  const config = vscode.workspace.getConfiguration('openblink');
  currentStatus.sourceFile = config.get<string>('sourceFile') ?? 'app.rb';
  currentStatus.slot = config.get<number>('slot') ?? 2;

  if (!ipcDirPath) {
    log('[MCP] Bridge initialized (no workspaceStorage available; IPC disabled).');
    enabled = false;
  } else if (enabled) {
    startTriggerWatcher();
    startCommandWatcher();
    // Seed status.json and build-status.json so the MCP server can
    // immediately read a consistent snapshot on first connection.
    statusThrottler.schedule();
    flushBuildStatus();
    log(`[MCP] Bridge initialized (IPC enabled at ${ipcDirPath}).`);
  } else {
    log('[MCP] Bridge initialized (IPC disabled).');
  }

  // Dispose watchers and throttlers on deactivation
  context.subscriptions.push({
    dispose: () => {
      enabled = false;
      triggerWatcher?.dispose();
      triggerWatcher = undefined;
      commandWatcher?.dispose();
      commandWatcher = undefined;
      statusThrottler.dispose();
      consoleThrottler.dispose();
    },
  });
}
