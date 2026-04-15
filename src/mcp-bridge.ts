/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

/**
 * @brief File-based IPC bridge between the VS Code extension and the MCP server.
 *
 * The extension (running inside the extension host process) and the MCP server
 * (running as a separate stdio-based Node.js process) communicate through JSON
 * files stored in the `.openblink/` directory at the workspace root:
 *
 *   - `status.json`  — Written by the extension (debounced 1 s) on connection
 *                       state changes and build completions.
 *   - `openblink-console.log` — Written by the extension (debounced 2 s) with
 *                       the most recent device console output (up to 100 lines).
 *   - `trigger.json` — Written by the MCP server to request a Build & Blink.
 *   - `result.json`  — Written by the extension after a triggered build
 *                       completes so the MCP server can return the outcome.
 *
 * All write operations are guarded by the `openblink.mcp.enabled` setting.
 * When the setting is `false`, no files are written and the FileSystemWatcher
 * for `trigger.json` is disposed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionState, MetricsData, MetricsStats } from './types';
import { getConsoleLog, log } from './ui-manager';

// ============================================================================
// Directory & File Paths
// ============================================================================

/** @brief Name of the IPC directory created at the workspace root. */
const IPC_DIR = '.openblink';

/** @brief Resolve the absolute path to the IPC directory for the first workspace folder. */
function ipcDir(): string | undefined {
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws ? path.join(ws.uri.fsPath, IPC_DIR) : undefined;
}

/** @brief Ensure the `.openblink/` directory exists. */
function ensureDir(): string | undefined {
  const dir = ipcDir();
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============================================================================
// Enabled State
// ============================================================================

/** @brief Current enabled state, mirroring `openblink.mcp.enabled`. */
let enabled = true;

/** @brief FileSystemWatcher for `trigger.json`. */
let triggerWatcher: vscode.FileSystemWatcher | undefined;

/** @brief Callback invoked when a build trigger is detected. */
let onTriggerCallback: ((filePath: string, requestId: string) => Promise<void>) | undefined;

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
 * @brief Check whether MCP bridge should be initialized.
 * 
 * Checks if MCP is enabled and if we're in a workspace context.
 * This allows the extension to defer MCP initialization until needed.
 * 
 * @returns `true` if MCP should be initialized.
 */
export function shouldInitialize(): boolean {
  if (!enabled) {
    return false;
  }
  
  // Check if we're in a workspace
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return false;
  }
  
  return true;
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
    // Disable: dispose watcher
    triggerWatcher?.dispose();
    triggerWatcher = undefined;
  } else if (!wasEnabled && enabled) {
    // Enable: re-create watcher
    startTriggerWatcher();
  }
}

// ============================================================================
// Status File (debounced 1 s)
// ============================================================================

/**
 * @brief Shape of the `status.json` file written to `.openblink/`.
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

/** @brief Debounce timer handle for status file writes. */
let statusTimer: ReturnType<typeof setTimeout> | undefined;

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

/**
 * @brief Merge partial updates into the current status and schedule a debounced write.
 * @param patch  Partial status fields to merge.
 */
export function updateStatus(patch: Partial<McpStatus>): void {
  if (!enabled) { return; }
  // NOTE: shallow merge — only use with top-level primitive fields.
  // For nested objects (connection, metrics, board), use the dedicated update functions.
  Object.assign(currentStatus, patch);
  scheduleStatusWrite();
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
  scheduleStatusWrite();
}

/**
 * @brief Update the metrics fields of the status.
 */
export function updateMetricsStatus(latest: MetricsData, stats: { compile: MetricsStats; transfer: MetricsStats; size: MetricsStats }): void {
  if (!enabled) { return; }
  currentStatus.metrics = { latest, stats };
  scheduleStatusWrite();
}

/**
 * @brief Update the board field of the status.
 */
export function updateBoardStatus(board: { name: string; displayName: string; referencePath: string } | null): void {
  if (!enabled) { return; }
  currentStatus.board = board;
  scheduleStatusWrite();
}

/**
 * @brief Update the last build result field of the status.
 */
export function updateBuildResult(success: boolean, error?: string): void {
  if (!enabled) { return; }
  currentStatus.lastBuild = { success, timestamp: new Date().toISOString(), error };
  scheduleStatusWrite();
}

/** @brief Schedule a debounced write of `status.json` (1 second delay). */
function scheduleStatusWrite(): void {
  if (statusTimer) { clearTimeout(statusTimer); }
  statusTimer = setTimeout(() => flushStatus(), 1000);
}

/** @brief Write the current status to `status.json`. */
function flushStatus(): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  let written = false;
  try {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(currentStatus, null, 2), 'utf-8');
    written = true;
  } catch {
    // Silently ignore write errors (e.g. permission issues)
  }
  if (written) { onStatusWrittenCallback?.(); }
}

// ============================================================================
// Console Log File (debounced 2 s)
// ============================================================================

/** @brief Debounce timer handle for console log file writes. */
let consoleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * @brief Schedule a debounced write of the console ring buffer to `openblink-console.log`.
 *
 * Called from the extension whenever new console output is received.
 * The actual file write is delayed by 2 seconds and batched.
 */
export function scheduleConsoleWrite(): void {
  if (!enabled) { return; }
  if (consoleTimer) { clearTimeout(consoleTimer); }
  consoleTimer = setTimeout(() => flushConsole(), 2000);
}

/** @brief Write the current console buffer to `openblink-console.log`. */
function flushConsole(): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  let written = false;
  try {
    const lines = getConsoleLog();
    fs.writeFileSync(path.join(dir, 'openblink-console.log'), lines.join('\n') + '\n', 'utf-8');
    written = true;
  } catch {
    // Silently ignore write errors
  }
  if (written) { onConsoleWrittenCallback?.(); }
}

// ============================================================================
// Build Result File (immediate write)
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
}

/**
 * @brief Write a build result file for the MCP server to consume.
 * @param result  Build outcome.
 */
export function writeBuildResult(result: McpBuildResult): void {
  if (!enabled) { return; }
  const dir = ensureDir();
  if (!dir) { return; }
  try {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');
  } catch {
    // Silently ignore write errors
  }
  log(`[MCP] Build result written: ${result.success ? 'Success' : 'Failed'}${result.error ? ` (${result.error})` : ''}`);
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
 * @brief Start watching for `trigger.json` in the `.openblink/` directory.
 *
 * Creates a {@link vscode.FileSystemWatcher} that fires when the MCP server
 * writes or updates the trigger file.  The watcher reads the trigger,
 * deletes the file, and invokes the registered callback.
 */
function startTriggerWatcher(): void {
  if (triggerWatcher) { return; }
  const dir = ipcDir();
  if (!dir) { return; }

  ensureDir();
  const pattern = new vscode.RelativePattern(dir, 'trigger.json');
  triggerWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);

  const handleTrigger = async () => {
    const triggerPath = path.join(dir, 'trigger.json');
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
      const trigger: McpBuildTrigger = JSON.parse(raw);
      if (!trigger.requestId || typeof trigger.requestId !== 'string') { return; }
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
          if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) { return; }
        }
        await onTriggerCallback(filePath, trigger.requestId);
      }
    } catch {
      // Ignore malformed trigger files
    }
  };

  triggerWatcher.onDidCreate(handleTrigger);
  triggerWatcher.onDidChange(handleTrigger);

  // Process any trigger.json that was written before the watcher started
  const existingTrigger = path.join(dir, 'trigger.json');
  if (fs.existsSync(existingTrigger)) {
    void handleTrigger();
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * @brief Initialize the MCP bridge.
 *
 * Reads the `openblink.mcp.enabled` setting, creates the IPC directory if
 * needed, and starts the trigger watcher if MCP is enabled.
 *
 * @param context  The extension context for registering disposables.
 */
export function initialize(context: vscode.ExtensionContext): void {
  enabled = vscode.workspace.getConfiguration('openblink').get<boolean>('mcp.enabled', true);

  // Read initial config values
  const config = vscode.workspace.getConfiguration('openblink');
  currentStatus.sourceFile = config.get<string>('sourceFile') ?? 'app.rb';
  currentStatus.slot = config.get<number>('slot') ?? 2;

  if (enabled) {
    startTriggerWatcher();
    scheduleStatusWrite();
    log('[MCP] Bridge initialized (IPC enabled).');
  } else {
    log('[MCP] Bridge initialized (IPC disabled).');
  }

  // Dispose watcher on deactivation
  context.subscriptions.push({
    dispose: () => {
      enabled = false;
      triggerWatcher?.dispose();
      triggerWatcher = undefined;
      if (statusTimer) { clearTimeout(statusTimer); }
      if (consoleTimer) { clearTimeout(consoleTimer); }
    },
  });
}
