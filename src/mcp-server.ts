#!/usr/bin/env node
/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

/**
 * @brief OpenBlink MCP Server — stdio-based Model Context Protocol server.
 *
 * This standalone Node.js script is bundled with the OpenBlink VS Code
 * extension and launched as a child process by the IDE's MCP client
 * (Windsurf Cascade, VS Code Copilot, Cursor, Cline, etc.).
 *
 * Communication with the extension happens through JSON files in the
 * extension's VS Code workspaceStorage `ipc/` subdirectory (file-based IPC).
 * The absolute path is passed via the `OPENBLINK_IPC_DIR` environment variable:
 *
 *   - Reads  `status.json`  for device info and metrics.
 *   - Reads  `openblink-console.log` for device console output.
 *   - Reads  `build-diagnostics.json` for detailed build error information.
 *   - Reads  `scanned-devices.json` for discovered BLE devices.
 *   - Writes `trigger.json` to request a Build & Blink.
 *   - Writes `command.json` to request device operations (scan, connect, reset).
 *   - Reads  `result.json`  for the build outcome.
 *   - Reads  `command-result.json` for operation results.
 *
 * Registered MCP tools:
 *   1. `build_and_blink` — Compile a .rb file and transfer via BLE.
 *   2. `validate_ruby_code` — Validate Ruby code without building.
 *   3. `get_device_info`  — Return the current device connection state.
 *   4. `scan_devices` — Scan for BLE devices and return discovered devices.
 *   5. `connect_device` — Connect to a BLE device by ID.
 *   6. `disconnect_device` — Disconnect from the current device.
 *   7. `soft_reset` — Execute soft reset on the connected device.
 *   8. `get_console_output` — Return recent device console output.
 *   9. `get_metrics`     — Return build/transfer metrics and statistics.
 *  10. `get_board_reference` — Return the board API reference (Markdown).
 *  11. `get_build_diagnostics` — Return detailed build error information.
 *  12. `get_build_status` — Check the status of an in-progress or recent build.
 *  13. `cancel_build` — Cancel a pending or in-progress build.
 *
 * Registered MCP resources (read-only views over the same IPC data):
 *   - `openblink://device/status`     — Live device connection status (JSON).
 *   - `openblink://console/recent`    — Recent device console output (text, subscribable).
 *   - `openblink://board/reference`   — Selected board API reference (Markdown).
 *   - `openblink://build/status`      — Current build system status (JSON, subscribable).
 *   - `openblink://build/diagnostics` — Last build diagnostics (JSON, subscribable).
 *
 * Registered MCP prompts (exposed as slash commands in VS Code chat):
 *   - `deploy-and-debug`   — Guided compile/transfer/verify workflow.
 *   - `fix-build-errors`   — Diagnose and fix the last failed build.
 *   - `write-board-program` — Write a new mruby program for the selected board.
 *   - `troubleshoot-connection` — Systematic BLE connection diagnosis.
 *
 * @see https://modelcontextprotocol.io/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { errorMessage } from './error-utils';

// ============================================================================
// Debug Logging
// ============================================================================

/**
 * @brief Debug flag toggled by the `OPENBLINK_MCP_DEBUG` environment variable.
 *
 * Set `OPENBLINK_MCP_DEBUG=1` (or `true`) in the MCP server env block of your
 * IDE's MCP configuration to enable verbose stderr logging.  Debug output is
 * visible in the MCP client's error stream and is invaluable when diagnosing
 * IPC timeouts, missing files, or race conditions.
 */
const DEBUG = (() => {
  const v = (process.env.OPENBLINK_MCP_DEBUG ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
})();

/**
 * @brief Write a debug line to stderr when `OPENBLINK_MCP_DEBUG` is enabled.
 *
 * When the MCP client is connected, the line is also forwarded as an MCP
 * `notifications/message` logging notification so clients that surface
 * server logs (e.g. VS Code's MCP output channel) can display it.
 */
function debug(msg: string): void {
  if (!DEBUG) { return; }
  process.stderr.write(`[openblink-mcp] ${new Date().toISOString()} ${msg}\n`);
  try {
    if (server?.isConnected()) {
      void server.server.sendLoggingMessage({ level: 'debug', logger: 'openblink', data: msg }).catch(() => { /* ignore */ });
    }
  } catch { /* logging must never break tool execution */ }
}

// ============================================================================
// Error Codes and Structured Responses
// ============================================================================

/** @brief Structured error codes for MCP tool responses */
enum ErrorCode {
  // General errors (1xxx)
  UNKNOWN_ERROR = 1000,
  INVALID_PARAMETER = 1001,
  TIMEOUT = 1002,
  NOT_INITIALIZED = 1003,
  OPERATION_CANCELLED = 1004,

  // File/Path errors (2xxx)
  FILE_NOT_FOUND = 2000,
  PATH_TRAVERSAL_DETECTED = 2001,
  FILE_ACCESS_DENIED = 2002,
  INVALID_FILE_TYPE = 2003,

  // Build errors (3xxx)
  COMPILATION_FAILED = 3000,
  SYNTAX_ERROR = 3001,
  BYTECODE_GENERATION_FAILED = 3002,

  // BLE/Connection errors (4xxx)
  BLE_NOT_AVAILABLE = 4000,
  DEVICE_NOT_CONNECTED = 4001,
  DEVICE_NOT_FOUND = 4002,
  CONNECTION_FAILED = 4003,
  TRANSFER_FAILED = 4004,
  MTU_NEGOTIATION_FAILED = 4005,

  // Board errors (5xxx)
  BOARD_NOT_SELECTED = 5000,
  REFERENCE_NOT_FOUND = 5001,
}

/** @brief Error severity levels */
type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/** @brief Structured error information */
interface McpError {
  code: ErrorCode;
  message: string;
  severity: ErrorSeverity;
  details?: string;
  recovery?: string;
}

/** @brief Error code to recovery suggestion mapping */
const ERROR_RECOVERY: Record<ErrorCode, string> = {
  [ErrorCode.UNKNOWN_ERROR]: 'Please try again. If the issue persists, restart the extension.',
  [ErrorCode.INVALID_PARAMETER]: 'Check the parameter format and try again.',
  [ErrorCode.TIMEOUT]: 'The operation timed out. Check device connection and try again.',
  [ErrorCode.NOT_INITIALIZED]: 'Wait for the extension to fully initialize, then retry.',
  [ErrorCode.OPERATION_CANCELLED]: 'The operation was cancelled. Retry if needed.',
  [ErrorCode.FILE_NOT_FOUND]: 'Ensure the file exists in the workspace and the path is correct.',
  [ErrorCode.PATH_TRAVERSAL_DETECTED]: 'Use only workspace-relative paths without ".." segments.',
  [ErrorCode.FILE_ACCESS_DENIED]: 'Check file permissions and ensure the file is not locked.',
  [ErrorCode.INVALID_FILE_TYPE]: 'Only .rb Ruby source files are supported.',
  [ErrorCode.COMPILATION_FAILED]: 'Fix the syntax errors in your code and retry.',
  [ErrorCode.SYNTAX_ERROR]: 'Review the error details and fix the syntax issues.',
  [ErrorCode.BYTECODE_GENERATION_FAILED]: 'Check for unsupported Ruby features in your code.',
  [ErrorCode.BLE_NOT_AVAILABLE]: 'Ensure Bluetooth is enabled on your system.',
  [ErrorCode.DEVICE_NOT_CONNECTED]: 'Connect to a device first using connect_device.',
  [ErrorCode.DEVICE_NOT_FOUND]: 'The specified device ID was not found. Run scan_devices first.',
  [ErrorCode.CONNECTION_FAILED]: 'Move the device closer and ensure it is powered on.',
  [ErrorCode.TRANSFER_FAILED]: 'Check device connection and MTU settings, then retry.',
  [ErrorCode.MTU_NEGOTIATION_FAILED]: 'Try reconnecting to the device.',
  [ErrorCode.BOARD_NOT_SELECTED]: 'Select a board using the OpenBlink sidebar first.',
  [ErrorCode.REFERENCE_NOT_FOUND]: 'The board reference file is missing. Reinstall the extension.',
};

/** @brief Create a structured error response */
function createError(code: ErrorCode, message: string, details?: string, severity: ErrorSeverity = 'error'): McpError {
  return {
    code,
    message,
    severity,
    details,
    recovery: ERROR_RECOVERY[code],
  };
}

/** @brief Format error for MCP response */
function formatErrorResponse(error: McpError): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const parts = [
    `[Error ${error.code}] ${error.severity.toUpperCase()}: ${error.message}`,
  ];
  if (error.details) {
    parts.push(`Details: ${error.details}`);
  }
  parts.push(`Recovery: ${error.recovery}`);
  return {
    content: [{ type: 'text' as const, text: parts.join('\n') }],
    isError: true,
  };
}

declare const EXTENSION_VERSION: string;

// ============================================================================
// IPC Directory
// ============================================================================

/**
 * @brief Resolve the IPC directory path shared with the extension.
 *
 * The absolute IPC directory is passed as the `OPENBLINK_IPC_DIR` environment
 * variable by the extension when it launches the MCP server.  The extension
 * points this at its workspaceStorage (`<storageUri>/ipc`) so no files are
 * written into the user's workspace tree.
 */
function getIpcDir(): string {
  const ipcDir = process.env.OPENBLINK_IPC_DIR;
  if (!ipcDir) {
    throw new Error('OPENBLINK_IPC_DIR environment variable is not set');
  }
  // Reject relative paths before resolving to prevent path traversal
  if (!path.isAbsolute(ipcDir)) {
    throw new Error('OPENBLINK_IPC_DIR must be an absolute path');
  }
  return path.resolve(ipcDir);
}

/** @brief Safely read and parse a JSON file.  Returns `null` on any error. */
function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Guard against transient truncated reads in case the writer did NOT use
    // atomic rename.  The extension bridge DOES use atomic rename, so this is
    // primarily defensive for older extensions.
    if (raw.length === 0) { return null; }
    return JSON.parse(raw);
  } catch (err) {
    debug(`readJsonFile(${path.basename(filePath)}) error: ${errorMessage(err)}`);
    return null;
  }
}

/** @brief Safely read a text file.  Returns `null` on any error. */
function readTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    debug(`readTextFile(${path.basename(filePath)}) error: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * @brief Atomically write a JSON file using a temp file + rename.
 *
 * Using `rename` — atomic on the same filesystem — guarantees the
 * extension's file watcher never reads a partially-written request
 * file.  Without this, a writer interrupted mid-flight would cause the
 * watcher to `JSON.parse` garbage, silently drop the request, and the
 * tool would time out.
 */
function writeJsonFile<T>(filePath: string, data: T): boolean {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    debug(`wrote ${path.basename(filePath)} (${JSON.stringify(data).length} chars)`);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    debug(`writeJsonFile(${path.basename(filePath)}) error: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * @brief Poll for a result file with timeout and optional cancellation check.
 *
 * Iteration notes:
 *   - On each tick, reads the result file and checks `idField === requestId`.
 *     If a stale result file (from a previous request) is present, this
 *     check skips it without deleting so it can be reconciled later.
 *   - `fs.unlinkSync` is called once the matching result is found to make
 *     room for the next request; failures (e.g. concurrent unlink by the
 *     extension) are ignored.
 *   - Cancellation is evaluated *before* each sleep and again *after*, so
 *     a cancel request is observed within one poll interval.
 */
async function pollForResult<T>(
  resultPath: string,
  timeout: number,
  pollInterval: number,
  requestId: string,
  idField: keyof T,
  isCancelled?: () => boolean,
): Promise<T | null> {
  debug(`pollForResult: waiting for ${requestId} at ${path.basename(resultPath)} (timeout=${timeout}ms, interval=${pollInterval}ms)`);
  const start = Date.now();
  let iterations = 0;
  let sawForeignResult = false;
  while (Date.now() - start < timeout) {
    if (isCancelled?.()) {
      debug(`pollForResult: cancelled (${requestId})`);
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    iterations++;
    const result = readJsonFile<T>(resultPath);
    if (result) {
      if ((result[idField] as unknown) === requestId) {
        try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
        debug(`pollForResult: matched ${requestId} in ${Date.now() - start}ms (${iterations} polls)`);
        return result;
      } else if (!sawForeignResult) {
        sawForeignResult = true;
        debug(`pollForResult: saw foreign result (${String((result as Record<string, unknown>)[idField as string])}) while waiting for ${requestId}`);
      }
    }
  }
  debug(`pollForResult: TIMEOUT ${requestId} after ${timeout}ms (${iterations} polls, foreignResult=${sawForeignResult})`);
  return null;
}

// ============================================================================
// Active Operations Tracking (for cancellation)
// ============================================================================

/** @brief Set of currently active operation request IDs */
const activeOperations = new Set<string>();

/** @brief Cancel an active operation by ID */
function cancelOperation(requestId: string): boolean {
  if (activeOperations.has(requestId)) {
    activeOperations.delete(requestId);
    return true;
  }
  return false;
}

/** @brief Check if an operation is cancelled */
function isOperationCancelled(requestId: string): boolean {
  return !activeOperations.has(requestId);
}

/** @brief Register a new operation */
function registerOperation(requestId: string): void {
  activeOperations.add(requestId);
}

/** @brief Complete an operation */
function completeOperation(requestId: string): void {
  activeOperations.delete(requestId);
}

// ============================================================================
// Shared Helpers (board reference resolution, BLE scan)
// ============================================================================

/** @brief Result of resolving and validating the selected board's reference file. */
type BoardReferenceResolution =
  | { ok: true; displayName: string; refPath: string }
  | { ok: false; error: string; isError: boolean };

/**
 * @brief Resolve the selected board's API reference path from `status.json`.
 *
 * Validates the path to prevent arbitrary file reads via a tampered
 * `status.json`:
 *   1. Must not contain any '..' path components.
 *   2. Must be a Markdown file (.md) to restrict to documentation.
 *   3. Must reside inside the extension directory (OPENBLINK_EXTENSION_DIR).
 */
function resolveBoardReference(dir: string): BoardReferenceResolution {
  const status = readJsonFile<{
    board: { name: string; displayName: string; referencePath: string } | null;
  }>(path.join(dir, 'status.json'));

  if (!status?.board) {
    // Informational, not a failure: an agent can guide the user to select a board.
    return { ok: false, error: 'No board selected. Use the OpenBlink sidebar to select a board.', isError: false };
  }

  const referencePathInput = status.board.referencePath;
  const normalizedRefPath = path.normalize(referencePathInput);
  const refPathSegments = normalizedRefPath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  const refPath = path.resolve(referencePathInput);
  if (refPathSegments.includes('..') || path.extname(refPath).toLowerCase() !== '.md') {
    return { ok: false, error: 'Board reference path is invalid or not a Markdown file.', isError: true };
  }
  const extensionDir = process.env.OPENBLINK_EXTENSION_DIR;
  if (!extensionDir) {
    return { ok: false, error: 'Extension directory is not configured. Cannot verify board reference path.', isError: true };
  }
  // Reject relative paths to prevent path traversal (SEC-07)
  if (!path.isAbsolute(extensionDir)) {
    return { ok: false, error: 'OPENBLINK_EXTENSION_DIR must be an absolute path.', isError: true };
  }
  const resolvedExtensionDir = path.resolve(extensionDir);
  const relativeRefPath = path.relative(resolvedExtensionDir, refPath);
  if (relativeRefPath === '..' || relativeRefPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRefPath)) {
    return { ok: false, error: 'Board reference path is outside the extension directory.', isError: true };
  }
  return { ok: true, displayName: status.board.displayName, refPath };
}

/** @brief A BLE device discovered during a scan. */
interface ScannedDevice {
  id: string;
  name: string;
  rssi?: number;
}

/**
 * @brief Run a BLE scan through the extension via file-based IPC.
 *
 * Writes a `scan` command to `command.json` and polls `command-result.json`
 * for a result matching `requestId`. Returns `null` on timeout.
 */
async function performScan(
  dir: string,
  scanTimeoutMs: number,
  requestId: string,
): Promise<{ success: boolean; devices?: ScannedDevice[]; error?: string } | null> {
  const command = {
    type: 'scan',
    requestId,
    timeout: scanTimeoutMs,
    timestamp: new Date().toISOString(),
  };

  if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
    return { success: false, error: 'Failed to write scan command' };
  }

  const resultPath = path.join(dir, 'command-result.json');
  return pollForResult<{
    requestId: string;
    success: boolean;
    devices?: ScannedDevice[];
    error?: string;
  }>(resultPath, scanTimeoutMs + 5000, 200, requestId, 'requestId', () => isOperationCancelled(requestId));
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: 'OpenBlink',
  title: 'OpenBlink',
  version: EXTENSION_VERSION,
}, {
  capabilities: {
    logging: {},
    resources: { subscribe: true, listChanged: true },
  },
  instructions:
    'OpenBlink programs microcontrollers with mruby via BLE.\n' +
    '\n' +
    '=== Device Connection Workflow ===\n' +
    '1. scan_devices — Discover BLE devices nearby\n' +
    '2. connect_device — Connect to a discovered device by ID\n' +
    '3. get_device_info — Verify connection status\n' +
    '\n' +
    '=== Development Workflow ===\n' +
    '1. get_board_reference — Read the board API reference BEFORE writing code\n' +
    '2. validate_ruby_code — Validate syntax without deploying (optional but recommended)\n' +
    '3. Edit the .rb source file\n' +
    '4. build_and_blink — Compile and transfer to the device\n' +
    '5. get_console_output — Check runtime output and errors\n' +
    '6. soft_reset — Reset the device if needed\n' +
    '\n' +
    '=== Debugging Workflow ===\n' +
    '- get_build_diagnostics — Get detailed error info after a failed build\n' +
    '- get_build_status — Check if a build is in progress\n' +
    '- cancel_build — Cancel a stuck build\n' +
    '- disconnect_device — Disconnect when finished\n' +
    '\n' +
    '=== Utility Tools ===\n' +
    '- get_metrics — Cumulative build/transfer statistics\n' +
    '- get_device_info — BLE connection status, MTU, device name\n' +
    '\n' +
    '=== Resources ===\n' +
    'Read-only resources mirror the tool data and can be attached as context:\n' +
    '- openblink://device/status — live connection status (JSON)\n' +
    '- openblink://console/recent — recent device console output (subscribable)\n' +
    '- openblink://board/reference — selected board API reference (Markdown)\n' +
    '- openblink://build/status — build system status (JSON, subscribable)\n' +
    '- openblink://build/diagnostics — last build diagnostics (JSON, subscribable)\n' +
    '\n' +
    '=== Prompts ===\n' +
    '- deploy-and-debug — guided compile/transfer/verify workflow\n' +
    '- fix-build-errors — diagnose and fix the last failed build\n' +
    '- write-board-program — write a new mruby program for the selected board\n' +
    '- troubleshoot-connection — systematic BLE connection diagnosis',
});

// ----------------------------------------------------------------------------
// Tool: build_and_blink
// ----------------------------------------------------------------------------

server.registerTool('build_and_blink', {
  title: 'Build & Blink',
  description:
    'Compile a Ruby (.rb) file with mruby and transfer the bytecode to a BLE-connected OpenBlink device. ' +
    'Call this after editing a .rb file to deploy changes to the hardware. ' +
    'Returns compile time, transfer time, program size, and success/error status. ' +
    'Requires an OpenBlink device to be connected via BLE for transfer (compilation works without a device). ' +
    'After success, use get_console_output to verify the program is running correctly. ' +
    'If the build fails, use get_build_diagnostics to get detailed error information.',
  inputSchema: {
    file: z.string().min(1).optional().describe(
      'Path to the .rb source file relative to the workspace root. ' +
      'If omitted, the configured openblink.sourceFile setting is used (default: app.rb).'
    ),
    timeout: z.number().int().min(5000).max(120000).optional().describe(
      'Custom timeout in milliseconds (default: 30000, min: 5000, max: 120000). ' +
      'Increase this for large files or slow connections.'
    ),
  },
  outputSchema: {
    requestId: z.string().describe('Unique request identifier for this build'),
    success: z.boolean().describe('Whether the build and transfer succeeded'),
    compileTime: z.number().optional().describe('Compilation time in milliseconds'),
    transferTime: z.number().optional().describe('BLE transfer time in milliseconds'),
    programSize: z.number().optional().describe('Compiled program size in bytes'),
    compiledWithoutTransfer: z.boolean().optional().describe('True when compilation succeeded but no device was connected'),
    error: z.string().optional().describe('Human-readable error message on failure'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ file, timeout: customTimeout }) => {
    debug(`build_and_blink: entered (file=${file ?? '(default)'}, timeout=${customTimeout ?? 'default'})`);
    // Validate file path
    if (file !== undefined) {
      const hasParentSegment = file
        .split(/[\\/]+/)
        .some(segment => segment === '..');

      if (path.isAbsolute(file) || hasParentSegment) {
        return formatErrorResponse(
          createError(ErrorCode.PATH_TRAVERSAL_DETECTED, 'Invalid file path')
        );
      }

      // Check file extension
      if (!file.endsWith('.rb')) {
        return formatErrorResponse(
          createError(ErrorCode.INVALID_FILE_TYPE, 'Only .rb files are supported', `File: ${file}`)
        );
      }
    }

    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(
        createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg)
      );
    }

    const requestId = `build_${randomUUID()}`;
    debug(`build_and_blink: requestId=${requestId}`);
    registerOperation(requestId);

    try {
      // Write trigger file with enhanced metadata
      const trigger = {
        file,
        requestId,
        timestamp: new Date().toISOString(),
        type: 'build',
      };

      if (!writeJsonFile(path.join(dir, 'trigger.json'), trigger)) {
        return formatErrorResponse(
          createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write build trigger')
        );
      }

      // Poll for result with configurable timeout
      const resultPath = path.join(dir, 'result.json');
      const timeout = customTimeout ?? 30_000;

      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        compileTime?: number;
        transferTime?: number;
        programSize?: number;
        error?: string;
        errorCode?: ErrorCode;
        compiledWithoutTransfer?: boolean;
      }>(resultPath, timeout, 200, requestId, 'requestId', () => isOperationCancelled(requestId));

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(
          createError(ErrorCode.OPERATION_CANCELLED, 'Build was cancelled')
        );
      }

      if (!result) {
        return formatErrorResponse(
          createError(ErrorCode.TIMEOUT, `Build timed out after ${timeout}ms`)
        );
      }

      if (result.success) {
        const parts = [
          `Build & Blink completed successfully.`,
          `Request ID: ${requestId}`,
          result.compileTime !== undefined ? `Compile time: ${result.compileTime.toFixed(1)} ms` : null,
          result.transferTime !== undefined ? `Transfer time: ${result.transferTime.toFixed(1)} ms` : null,
          result.programSize !== undefined ? `Program size: ${result.programSize} bytes` : null,
          result.compiledWithoutTransfer ? 'Note: Compiled successfully but device was not connected.' : null,
          `Next: Use get_console_output to check device runtime output.`,
        ].filter(Boolean);
        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
          structuredContent: {
            requestId,
            success: true,
            ...(result.compileTime !== undefined ? { compileTime: result.compileTime } : {}),
            ...(result.transferTime !== undefined ? { transferTime: result.transferTime } : {}),
            ...(result.programSize !== undefined ? { programSize: result.programSize } : {}),
            ...(result.compiledWithoutTransfer ? { compiledWithoutTransfer: true } : {}),
          },
        };
      } else {
        // Map extension error to appropriate error code
        const errorCode = result.errorCode ?? ErrorCode.COMPILATION_FAILED;
        return formatErrorResponse(
          createError(
            errorCode,
            'Build failed',
            result.error,
            errorCode === ErrorCode.SYNTAX_ERROR ? 'warning' : 'error'
          )
        );
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: get_device_info
// ----------------------------------------------------------------------------

server.registerTool('get_device_info', {
  title: 'Get Device Info',
  description:
    'Get the current BLE connection state and device information for the connected OpenBlink device. ' +
    'Returns connection state (disconnected/connecting/connected/reconnecting), device name, device ID, and negotiated MTU. ' +
    'Call this to check if a device is connected before running build_and_blink.',
  inputSchema: {},
  outputSchema: {
    available: z.boolean().describe('Whether extension status data is available'),
    state: z.string().optional().describe('Connection state: disconnected | connecting | connected | reconnecting'),
    deviceName: z.string().nullable().optional().describe('Advertised local name of the connected device'),
    deviceId: z.string().nullable().optional().describe('Noble peripheral identifier of the connected device'),
    mtu: z.number().optional().describe('Negotiated BLE MTU in bytes'),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
    debug(`get_device_info: reading status.json from ${dir}`);
    const status = readJsonFile<{ connection: { state: string; deviceName: string | null; deviceId: string | null; mtu: number } }>(
      path.join(dir, 'status.json'),
    );

    if (!status) {
      debug('get_device_info: status.json missing or unreadable');
      return {
        content: [{ type: 'text' as const, text: 'No status available. Is the OpenBlink extension running with MCP enabled?' }],
        structuredContent: { available: false },
      };
    }

    const c = status.connection;
    const lines = [
      `Connection state: ${c.state}`,
      `Device name: ${c.deviceName ?? '(none)'}`,
      `Device ID: ${c.deviceId ?? '(none)'}`,
      `MTU: ${c.mtu}`,
    ];
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        available: true,
        state: c.state,
        deviceName: c.deviceName,
        deviceId: c.deviceId,
        mtu: c.mtu,
      },
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_console_output
// ----------------------------------------------------------------------------

server.registerTool('get_console_output', {
  title: 'Get Console Output',
  description:
    'Get recent console output from the connected OpenBlink device. ' +
    'Returns up to 100 lines of the most recent [DEVICE] log messages. ' +
    'Use this after build_and_blink to see runtime output, debug prints, and error messages from the mruby/c program running on the device.',
  inputSchema: {
    lines: z.number().int().min(1).max(100).optional().describe(
      'Maximum number of lines to return (1–100, default: all available, up to 100).'
    ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ lines: maxLines }) => {
    const dir = getIpcDir();
    const logPath = path.join(dir, 'openblink-console.log');
    debug(`get_console_output: reading ${logPath} (maxLines=${maxLines ?? 'default'})`);
    const raw = readTextFile(logPath);

    if (raw === null) {
      debug('get_console_output: file does not exist (extension has not written any console output yet, or MCP is disabled)');
      return { content: [{ type: 'text' as const, text: 'No console output available. The extension has not recorded any device output yet.' }] };
    }
    if (raw.trim().length === 0) {
      debug('get_console_output: file is empty');
      return { content: [{ type: 'text' as const, text: 'No console output available.' }] };
    }

    let logLines = raw.split('\n').filter(l => l.length > 0);
    const totalLines = logLines.length;
    const cap = (maxLines !== undefined && maxLines > 0) ? maxLines : 100;
    logLines = logLines.slice(-cap);
    debug(`get_console_output: returning ${logLines.length}/${totalLines} lines (${raw.length} bytes)`);

    return { content: [{ type: 'text' as const, text: logLines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_metrics
// ----------------------------------------------------------------------------

server.registerTool('get_metrics', {
  title: 'Get Build Metrics',
  description:
    'Get cumulative build and transfer metrics for the OpenBlink extension. ' +
    'Returns the latest compile time, transfer time, program size, and min/avg/max statistics across recent builds. ' +
    'Unlike build_and_blink (which returns only the current build metrics), this shows historical performance trends.',
  inputSchema: {},
  outputSchema: {
    available: z.boolean().describe('Whether metrics data is available'),
    latest: z.object({
      compileTime: z.number().optional().describe('Latest compile time in milliseconds'),
      transferTime: z.number().optional().describe('Latest BLE transfer time in milliseconds'),
      programSize: z.number().optional().describe('Latest compiled program size in bytes'),
    }).optional(),
    stats: z.object({
      compile: z.object({
        min: z.number().nullable(),
        avg: z.number().nullable(),
        max: z.number().nullable(),
      }).describe('Compile time statistics (milliseconds)'),
      transfer: z.object({
        min: z.number().nullable(),
        avg: z.number().nullable(),
        max: z.number().nullable(),
      }).describe('Transfer time statistics (milliseconds)'),
      size: z.object({
        min: z.number().nullable(),
        avg: z.number().nullable(),
        max: z.number().nullable(),
      }).describe('Program size statistics (bytes)'),
    }).optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
    const status = readJsonFile<{
      metrics: {
        latest: { compileTime?: number; transferTime?: number; programSize?: number };
        stats: {
          compile: { min: number | null; avg: number | null; max: number | null };
          transfer: { min: number | null; avg: number | null; max: number | null };
          size: { min: number | null; avg: number | null; max: number | null };
        };
      };
    }>(path.join(dir, 'status.json'));

    if (!status) {
      return {
        content: [{ type: 'text' as const, text: 'No metrics available. Is the OpenBlink extension running with MCP enabled?' }],
        structuredContent: { available: false },
      };
    }

    const m = status.metrics;
    const fmt = (v: number | undefined | null, unit: string) =>
      v !== undefined && v !== null ? `${v.toFixed?.(1) ?? v} ${unit}` : '--';
    const fmtStat = (s: { min: number | null; avg: number | null; max: number | null }, unit: string) =>
      `min=${fmt(s.min, unit)} avg=${fmt(s.avg, unit)} max=${fmt(s.max, unit)}`;

    const lines = [
      `=== Latest Build ===`,
      `Compile time: ${fmt(m.latest.compileTime, 'ms')}`,
      `Transfer time: ${fmt(m.latest.transferTime, 'ms')}`,
      `Program size: ${fmt(m.latest.programSize, 'bytes')}`,
      ``,
      `=== Statistics ===`,
      `Compile: ${fmtStat(m.stats.compile, 'ms')}`,
      `Transfer: ${fmtStat(m.stats.transfer, 'ms')}`,
      `Size: ${fmtStat(m.stats.size, 'bytes')}`,
    ];
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        available: true,
        latest: m.latest,
        stats: m.stats,
      },
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_board_reference
// ----------------------------------------------------------------------------

server.registerTool('get_board_reference', {
  title: 'Get Board Reference',
  description:
    'Get the API reference documentation (Markdown) for the currently selected OpenBlink board. ' +
    'Returns the board name and the full reference Markdown content describing available APIs ' +
    '(LED, GPIO, Sleep, etc.) that can be used in mruby programs. ' +
    'IMPORTANT: Always call this before writing or modifying mruby code to understand the available APIs.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
    const resolved = resolveBoardReference(dir);
    if (!resolved.ok) {
      return resolved.isError
        ? { content: [{ type: 'text' as const, text: resolved.error }], isError: true }
        : { content: [{ type: 'text' as const, text: resolved.error }] };
    }
    const { displayName, refPath } = resolved;
    const refContent = readTextFile(refPath);
    if (!refContent) {
      return { content: [{ type: 'text' as const, text: `Board "${displayName}" selected, but reference file not found at: ${refPath}` }] };
    }

    // Truncate to protect AI context window from excessively large reference files.
    const MAX_REF_SIZE = 50_000;
    const safeContent = refContent.length > MAX_REF_SIZE
      ? refContent.slice(0, MAX_REF_SIZE) + '\n\n[Truncated — content exceeds 50 KB limit]'
      : refContent;

    // Expose the reference file as a resource_link so MCP clients can open
    // the raw Markdown in a separate view when desired (VS Code 1.103+).
    return {
      content: [
        { type: 'text' as const, text: `# ${displayName}\n\n${safeContent}` },
        {
          type: 'resource_link' as const,
          uri: pathToFileURL(refPath).href,
          name: `${displayName} Reference`,
          description: 'Board API reference (Markdown)',
          mimeType: 'text/markdown',
        },
      ],
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: validate_ruby_code
// ----------------------------------------------------------------------------

server.registerTool('validate_ruby_code', {
  title: 'Validate Ruby Code',
  description:
    'Validate Ruby syntax without compiling or transferring to a device. ' +
    'This is a lightweight check that catches syntax errors quickly without requiring a BLE connection. ' +
    'Use this before build_and_blink to catch errors early. ' +
    'Returns syntax validation result and any error messages.',
  inputSchema: {
    file: z.string().min(1).optional().describe(
      'Path to the .rb source file relative to the workspace root. ' +
      'Either file or code must be provided.'
    ),
    code: z.string().optional().describe(
      'Ruby source code to validate directly. If provided, this takes precedence over the file parameter.'
    ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ file, code }) => {
    // Validate parameters
    if (!file && !code) {
      return formatErrorResponse(
        createError(ErrorCode.INVALID_PARAMETER, 'Either file or code must be provided')
      );
    }

    // Validate file path if provided
    if (file) {
      const hasParentSegment = file.split(/[\\/]+/).some(segment => segment === '..');
      if (path.isAbsolute(file) || hasParentSegment) {
        return formatErrorResponse(createError(ErrorCode.PATH_TRAVERSAL_DETECTED, 'Invalid file path'));
      }
      if (!file.endsWith('.rb')) {
        return formatErrorResponse(createError(ErrorCode.INVALID_FILE_TYPE, 'Only .rb files are supported'));
      }
    }

    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `validate_${randomUUID()}`;
    registerOperation(requestId);

    try {
      // Write validation command (uses command.json, not trigger.json,
      // so the extension routes it to the validate handler which supports
      // both 'file' and 'code' parameters)
      const command = {
        type: 'validate',
        requestId,
        file,
        code,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write validation command'));
      }

      // Poll for command result
      const resultPath = path.join(dir, 'command-result.json');
      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        error?: string;
        diagnostics?: Array<{ line: number; column: number; message: string; severity: string }>;
      }>(resultPath, 15_000, 200, requestId, 'requestId', () => isOperationCancelled(requestId));

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(createError(ErrorCode.OPERATION_CANCELLED, 'Validation was cancelled'));
      }

      if (!result) {
        return formatErrorResponse(createError(ErrorCode.TIMEOUT, 'Validation timed out after 15 seconds'));
      }

      if (result.success) {
        return { content: [{ type: 'text' as const, text: 'Ruby code syntax is valid.' }] };
      } else {
        let errorText = `Syntax validation failed: ${result.error ?? 'Unknown error'}`;
        if (result.diagnostics && result.diagnostics.length > 0) {
          errorText += '\n\nDiagnostics:';
          for (const d of result.diagnostics) {
            errorText += `\n  Line ${d.line}, Col ${d.column}: [${d.severity}] ${d.message}`;
          }
        }
        return formatErrorResponse(
          createError(ErrorCode.SYNTAX_ERROR, 'Syntax validation failed', errorText, 'warning')
        );
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: scan_devices
// ----------------------------------------------------------------------------

server.registerTool('scan_devices', {
  title: 'Scan BLE Devices',
  description:
    'Scan for nearby BLE devices that support OpenBlink. ' +
    'Returns a list of discovered devices with their names and IDs. ' +
    'Use this to find devices to connect to. The scan runs for approximately 10 seconds.',
  inputSchema: {
    timeout: z.number().int().min(3000).max(30000).optional().describe(
      'Scan duration in milliseconds (default: 10000, min: 3000, max: 30000)'
    ),
  },
  outputSchema: {
    success: z.boolean().describe('Whether the scan completed successfully'),
    devices: z.array(z.object({
      id: z.string().describe('BLE device identifier'),
      name: z.string().describe('Advertised device name'),
      rssi: z.number().optional().describe('Signal strength in dBm, if available'),
    })).describe('Discovered devices'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ timeout: customTimeout }) => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `scan_${randomUUID()}`;
    registerOperation(requestId);

    try {
      const result = await performScan(dir, customTimeout ?? 10000, requestId);

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(createError(ErrorCode.OPERATION_CANCELLED, 'Scan was cancelled'));
      }

      if (!result) {
        return formatErrorResponse(createError(ErrorCode.TIMEOUT, 'Scan timed out'));
      }

      if (result.success && result.devices) {
        if (result.devices.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No OpenBlink devices found nearby. Ensure the device is powered on and in range.' }],
            structuredContent: { success: true, devices: [] },
          };
        }
        const lines = [
          `Found ${result.devices.length} device(s):`,
          ...result.devices.map(d => `  - ${d.name} (ID: ${d.id}${d.rssi !== undefined ? `, RSSI: ${d.rssi}dBm` : ''})`),
          '',
          'Use connect_device with the device ID to connect.',
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: { success: true, devices: result.devices },
        };
      } else {
        return formatErrorResponse(createError(ErrorCode.BLE_NOT_AVAILABLE, 'Scan failed', result.error));
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: connect_device
// ----------------------------------------------------------------------------

server.registerTool('connect_device', {
  title: 'Connect Device',
  description:
    'Connect to an OpenBlink BLE device by its ID. ' +
    'The device ID must be obtained from scan_devices first. ' +
    'If deviceId is omitted and the client supports elicitation, a scan is performed ' +
    'and the user is asked to pick a device. ' +
    'After connecting, use get_device_info to verify the connection.',
  inputSchema: {
    deviceId: z.string().min(1).optional().describe(
      'The BLE device ID from scan_devices. May be omitted when the MCP client ' +
      'supports elicitation; the user is then asked to select a device interactively.'
    ),
    timeout: z.number().int().min(5000).max(60000).optional().describe(
      'Connection timeout in milliseconds (default: 10000, max: 60000)'
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ deviceId, timeout: customTimeout }) => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    if (!deviceId) {
      // Without a deviceId, fall back to scan + elicitation so the user can
      // pick a device interactively (supported by VS Code 1.101+).
      if (!server.server.getClientCapabilities()?.elicitation) {
        return formatErrorResponse(createError(
          ErrorCode.INVALID_PARAMETER,
          'deviceId is required',
          'This MCP client does not support elicitation, so the device cannot be selected interactively. Run scan_devices and pass the deviceId explicitly.'
        ));
      }

      const scanRequestId = `scan_${randomUUID()}`;
      registerOperation(scanRequestId);
      let scanResult: Awaited<ReturnType<typeof performScan>>;
      try {
        scanResult = await performScan(dir, 10000, scanRequestId);
      } finally {
        completeOperation(scanRequestId);
      }

      const devices = scanResult?.success ? (scanResult.devices ?? []) : [];
      if (devices.length === 0) {
        return formatErrorResponse(createError(
          ErrorCode.DEVICE_NOT_FOUND,
          'No OpenBlink devices found nearby',
          scanResult?.error ?? 'Ensure the device is powered on and in range, then retry.'
        ));
      }

      // Device names/RSSI are embedded in the message because `enumNames`
      // is a UI hint that not all elicitation clients render.
      const labels = devices.map(d => `${d.name} (${d.id}${d.rssi !== undefined ? `, ${d.rssi}dBm` : ''})`);
      let elicited;
      try {
        elicited = await server.server.elicitInput({
          message: `Select the OpenBlink device to connect to. Discovered devices:\n${labels.map(l => `- ${l}`).join('\n')}`,
          requestedSchema: {
            type: 'object',
            properties: {
              device: {
                type: 'string',
                title: 'Device',
                description: 'Discovered OpenBlink BLE devices',
                enum: devices.map(d => d.id),
                enumNames: labels,
              },
            },
            required: ['device'],
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return formatErrorResponse(createError(ErrorCode.INVALID_PARAMETER, 'Device selection failed', msg));
      }

      if (elicited.action !== 'accept' || typeof elicited.content?.device !== 'string') {
        return formatErrorResponse(createError(
          ErrorCode.OPERATION_CANCELLED,
          'Device selection was declined or cancelled',
          undefined,
          'info'
        ));
      }
      deviceId = elicited.content.device;
    }

    const requestId = `connect_${randomUUID()}`;
    registerOperation(requestId);

    try {
      // Write connect command
      const command = {
        type: 'connect',
        requestId,
        deviceId,
        timeout: customTimeout ?? 10000,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write connect command'));
      }

      // Poll for command result
      const resultPath = path.join(dir, 'command-result.json');
      const timeout = (customTimeout ?? 10000) + 5000;

      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        deviceName?: string;
        mtu?: number;
        error?: string;
      }>(resultPath, timeout, 200, requestId, 'requestId', () => isOperationCancelled(requestId));

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(createError(ErrorCode.OPERATION_CANCELLED, 'Connection was cancelled'));
      }

      if (!result) {
        return formatErrorResponse(createError(ErrorCode.TIMEOUT, 'Connection timed out'));
      }

      if (result.success) {
        const lines = [
          `Connected to ${result.deviceName ?? 'device'}.`,
          `Device ID: ${deviceId}`,
          `MTU: ${result.mtu ?? 'unknown'}`,
          '',
          'Use get_device_info to verify connection status.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } else {
        return formatErrorResponse(createError(
          ErrorCode.CONNECTION_FAILED,
          'Failed to connect to device',
          result.error
        ));
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: disconnect_device
// ----------------------------------------------------------------------------

server.registerTool('disconnect_device', {
  title: 'Disconnect Device',
  description:
    'Disconnect from the currently connected OpenBlink device. ' +
    'This gracefully closes the BLE connection. Use this when finished working with the device.',
  inputSchema: {
    force: z.boolean().optional().describe(
      'Force disconnect even if operations are pending (default: false)'
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ force }) => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `disconnect_${randomUUID()}`;

    try {
      // Write disconnect command
      const command = {
        type: 'disconnect',
        requestId,
        force: force ?? false,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write disconnect command'));
      }

      // Poll for command result (short timeout for disconnect)
      const resultPath = path.join(dir, 'command-result.json');
      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        error?: string;
      }>(resultPath, 5000, 100, requestId, 'requestId');

      if (result?.success) {
        return { content: [{ type: 'text' as const, text: 'Disconnected from device.' }] };
      } else {
        return formatErrorResponse(createError(
          ErrorCode.DEVICE_NOT_CONNECTED,
          'Disconnect failed or no device was connected',
          result?.error
        ));
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: soft_reset
// ----------------------------------------------------------------------------

server.registerTool('soft_reset', {
  title: 'Soft Reset Device',
  description:
    'Execute a reset on the connected OpenBlink device. ' +
    'This triggers a full microcontroller reboot — the BLE connection will be dropped and the device will re-advertise. ' +
    'Use this to recover from errors or when a clean hardware-level restart is required. ' +
    'Note: After reset, you will need to reconnect using connect_device.',
  inputSchema: {
    slot: z.number().int().min(1).max(2).optional().describe(
      'Program slot to reset (1 or 2). If omitted, uses the currently configured slot.'
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
}, async ({ slot }) => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `reset_${randomUUID()}`;
    registerOperation(requestId);

    try {
      // Write reset command
      const command = {
        type: 'reset',
        requestId,
        slot,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write reset command'));
      }

      // Poll for command result
      const resultPath = path.join(dir, 'command-result.json');
      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        error?: string;
      }>(resultPath, 10000, 100, requestId, 'requestId', () => isOperationCancelled(requestId));

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(createError(ErrorCode.OPERATION_CANCELLED, 'Reset was cancelled'));
      }

      if (result?.success) {
        return { content: [{ type: 'text' as const, text: `Soft reset executed${slot ? ` on slot ${slot}` : ''}.` }] };
      } else {
        return formatErrorResponse(createError(
          ErrorCode.DEVICE_NOT_CONNECTED,
          'Reset failed',
          result?.error ?? 'Device may not be connected'
        ));
      }
    } finally {
      completeOperation(requestId);
    }
  },
);

// ----------------------------------------------------------------------------
// Tool: get_build_diagnostics
// ----------------------------------------------------------------------------

server.registerTool('get_build_diagnostics', {
  title: 'Get Build Diagnostics',
  description:
    'Get detailed diagnostic information about the most recent build failure. ' +
    'Returns syntax errors, line numbers, column positions, and suggested fixes. ' +
    'Use this after build_and_blink fails to understand what went wrong.',
  inputSchema: {},
  outputSchema: {
    available: z.boolean().describe('Whether diagnostic data is available'),
    timestamp: z.string().optional().describe('ISO 8601 timestamp of the build'),
    file: z.string().optional().describe('Source file path of the build'),
    success: z.boolean().optional().describe('Whether the last build succeeded'),
    errors: z.array(z.object({
      line: z.number(),
      column: z.number(),
      message: z.string(),
      severity: z.enum(['error', 'warning']),
      code: z.string().optional(),
    })).optional().describe('Error details, if any'),
    suggestions: z.array(z.string()).optional().describe('Suggested fixes'),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const diagnostics = readJsonFile<{
      timestamp: string;
      file: string;
      success: boolean;
      errors: Array<{
        line: number;
        column: number;
        message: string;
        severity: 'error' | 'warning';
        code?: string;
      }>;
      suggestions?: string[];
    }>(path.join(dir, 'build-diagnostics.json'));

    if (!diagnostics) {
      return {
        content: [{ type: 'text' as const, text: 'No build diagnostics available. Run build_and_blink first.' }],
        structuredContent: { available: false },
      };
    }

    // Build a resource_link to the source file so MCP clients can open it
    // directly (VS Code 1.103+ handles this by offering drag-into-chat and
    // click-to-open actions on the returned resource).
    const fileResourceLink = {
      type: 'resource_link' as const,
      uri: pathToFileURL(diagnostics.file).href,
      name: path.basename(diagnostics.file),
      description: `Source file: ${diagnostics.file}`,
      mimeType: 'text/x-ruby',
    };

    if (diagnostics.success) {
      return {
        content: [
          { type: 'text' as const, text: `Last build (${diagnostics.file}) was successful.` },
          fileResourceLink,
        ],
        structuredContent: {
          available: true,
          timestamp: diagnostics.timestamp,
          file: diagnostics.file,
          success: true,
          errors: [],
          suggestions: diagnostics.suggestions ?? [],
        },
      };
    }

    const lines = [
      `Build diagnostics for ${diagnostics.file} (at ${diagnostics.timestamp}):`,
      '',
      `Found ${diagnostics.errors.length} issue(s):`,
    ];

    for (const error of diagnostics.errors) {
      lines.push(`  [${error.severity.toUpperCase()}] Line ${error.line}, Col ${error.column}: ${error.message}`);
      if (error.code) {
        lines.push(`    Error code: ${error.code}`);
      }
    }

    if (diagnostics.suggestions && diagnostics.suggestions.length > 0) {
      lines.push('', 'Suggestions:');
      for (const suggestion of diagnostics.suggestions) {
        lines.push(`  - ${suggestion}`);
      }
    }

    return {
      content: [
        { type: 'text' as const, text: lines.join('\n') },
        fileResourceLink,
      ],
      structuredContent: {
        available: true,
        timestamp: diagnostics.timestamp,
        file: diagnostics.file,
        success: false,
        errors: diagnostics.errors,
        suggestions: diagnostics.suggestions ?? [],
      },
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_build_status
// ----------------------------------------------------------------------------

server.registerTool('get_build_status', {
  title: 'Get Build Status',
  description:
    'Check the current status of the build system. ' +
    'Returns whether a build is in progress, the last build result, and queue information. ' +
    'Use this to check if you can start a new build or to see if a previous build completed.',
  inputSchema: {},
  outputSchema: {
    available: z.boolean().describe('Whether build status data is available'),
    isBuilding: z.boolean().optional().describe('Whether a build is currently in progress'),
    queueLength: z.number().optional().describe('Number of pending builds in queue'),
    lastBuild: z.object({
      requestId: z.string(),
      success: z.boolean(),
      timestamp: z.string(),
      file: z.string(),
    }).nullable().optional().describe('Information about the last build'),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const status = readJsonFile<{
      isBuilding: boolean;
      lastBuild: {
        requestId: string;
        success: boolean;
        timestamp: string;
        file: string;
      } | null;
      queueLength: number;
    }>(path.join(dir, 'build-status.json'));

    if (!status) {
      // Fallback to checking status.json for lastBuild
      const basicStatus = readJsonFile<{ lastBuild: { success: boolean; timestamp: string } | null }>(
        path.join(dir, 'status.json')
      );

      if (!basicStatus) {
        return {
          content: [{ type: 'text' as const, text: 'No build status available. Is the extension running?' }],
          structuredContent: { available: false },
        };
      }

      const lines = ['Build Status:'];
      if (basicStatus.lastBuild) {
        lines.push(`  Last build: ${basicStatus.lastBuild.success ? 'Success' : 'Failed'} at ${basicStatus.lastBuild.timestamp}`);
      } else {
        lines.push('  No builds have been run yet.');
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: { available: true, isBuilding: false, queueLength: 0, lastBuild: null },
      };
    }

    const lines = ['Build Status:'];
    lines.push(`  Building: ${status.isBuilding ? 'Yes' : 'No'}`);
    lines.push(`  Queue: ${status.queueLength} pending`);

    if (status.lastBuild) {
      lines.push(`  Last build: ${status.lastBuild.success ? 'Success' : 'Failed'} at ${status.lastBuild.timestamp}`);
      lines.push(`  File: ${status.lastBuild.file}`);
      lines.push(`  Request ID: ${status.lastBuild.requestId}`);
    } else {
      lines.push('  Last build: None');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: {
        available: true,
        isBuilding: status.isBuilding,
        queueLength: status.queueLength,
        lastBuild: status.lastBuild,
      },
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: cancel_build
// ----------------------------------------------------------------------------

server.registerTool('cancel_build', {
  title: 'Cancel Build',
  description:
    'Cancel a pending or in-progress build. ' +
    'Use this if a build is taking too long or if you need to stop the current operation. ' +
    'Returns whether a build was successfully cancelled.',
  inputSchema: {
    requestId: z.string().optional().describe(
      'The request ID of the build to cancel. If omitted, cancels the current active build.'
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ requestId: targetRequestId }) => {
    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = errorMessage(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    // Determine which operation to cancel
    let toCancel: string | undefined = targetRequestId;
    if (!toCancel) {
      // Find the most recent active build operation
      for (const op of activeOperations) {
        if (op.startsWith('build_')) {
          toCancel = op;
          break;
        }
      }
    }

    if (!toCancel) {
      return { content: [{ type: 'text' as const, text: 'No active build to cancel.' }] };
    }

    // Write cancel command
    const command = {
      type: 'cancel',
      requestId: `cancel_${randomUUID()}`,
      targetRequestId: toCancel,
      timestamp: new Date().toISOString(),
    };

    if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
      return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write cancel command'));
    }

    // Cancel locally
    const wasCancelled = cancelOperation(toCancel);

    if (wasCancelled) {
      return { content: [{ type: 'text' as const, text: `Cancelled build ${toCancel}.` }] };
    } else {
      return { content: [{ type: 'text' as const, text: `Build ${toCancel} was not active or already completed.` }] };
    }
  },
);

// ============================================================================
// Resources
// ============================================================================
//
// Read-only views over the same IPC data the tools use.  Clients can browse
// these (VS Code: "MCP: Browse Resources"), attach them as chat context, and
// subscribe to update notifications for the frequently-changing ones.

/** @brief Maximum content size returned for any resource (bytes). */
const MAX_RESOURCE_SIZE = 100_000;

/** @brief Truncate resource text to a bounded size to protect client context windows. */
function boundResourceText(text: string): string {
  return text.length > MAX_RESOURCE_SIZE
    ? text.slice(0, MAX_RESOURCE_SIZE) + '\n\n[Truncated — content exceeds 100 KB limit]'
    : text;
}

/** @brief Read a JSON IPC file and wrap it as an MCP resource result. */
function jsonIpcResource(uri: string, fileName: string, missingMessage: string): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const raw = readTextFile(path.join(getIpcDir(), fileName));
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: raw !== null && raw.length > 0 ? boundResourceText(raw) : JSON.stringify({ available: false, message: missingMessage }),
    }],
  };
}

server.registerResource(
  'device-status',
  'openblink://device/status',
  {
    title: 'Device Status',
    description: 'Live BLE connection state, selected board, and build metrics of the OpenBlink extension (JSON).',
    mimeType: 'application/json',
  },
  async (uri) => jsonIpcResource(uri.href, 'status.json', 'The OpenBlink extension has not written status data yet. Is MCP enabled?'),
);

server.registerResource(
  'build-status',
  'openblink://build/status',
  {
    title: 'Build Status',
    description: 'Current build system status: whether a build is in progress, queue length, and last build result (JSON).',
    mimeType: 'application/json',
  },
  async (uri) => jsonIpcResource(uri.href, 'build-status.json', 'No build status recorded yet. Run build_and_blink first.'),
);

server.registerResource(
  'build-diagnostics',
  'openblink://build/diagnostics',
  {
    title: 'Build Diagnostics',
    description: 'Detailed diagnostics of the most recent build: errors, line/column positions, and suggested fixes (JSON).',
    mimeType: 'application/json',
  },
  async (uri) => jsonIpcResource(uri.href, 'build-diagnostics.json', 'No build diagnostics recorded yet. Run build_and_blink first.'),
);

server.registerResource(
  'console-output',
  'openblink://console/recent',
  {
    title: 'Device Console Output',
    description: 'Recent console output from the connected OpenBlink device ([DEVICE] log lines). Subscribable for live updates.',
    mimeType: 'text/plain',
  },
  async (uri) => {
    const raw = readTextFile(path.join(getIpcDir(), 'openblink-console.log'));
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/plain',
        text: raw !== null && raw.trim().length > 0
          ? boundResourceText(raw)
          : 'No console output available. The extension has not recorded any device output yet.',
      }],
    };
  },
);

server.registerResource(
  'board-reference',
  'openblink://board/reference',
  {
    title: 'Board API Reference',
    description: 'API reference (Markdown) for the currently selected OpenBlink board: available classes, methods, and examples.',
    mimeType: 'text/markdown',
  },
  async (uri) => {
    const resolved = resolveBoardReference(getIpcDir());
    if (!resolved.ok) {
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: resolved.error }] };
    }
    const refContent = readTextFile(resolved.refPath);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: refContent !== null
          ? boundResourceText(`# ${resolved.displayName}\n\n${refContent}`)
          : `Board "${resolved.displayName}" selected, but the reference file was not found.`,
      }],
    };
  },
);

// ----------------------------------------------------------------------------
// Resource update notifications (resources/subscribe)
// ----------------------------------------------------------------------------

/** @brief Map of subscribable resource URIs to the IPC file that backs them. */
const SUBSCRIBABLE_RESOURCES: Record<string, string> = {
  'openblink://device/status': 'status.json',
  'openblink://build/status': 'build-status.json',
  'openblink://build/diagnostics': 'build-diagnostics.json',
  'openblink://console/recent': 'openblink-console.log',
};

/** @brief URIs the client has subscribed to via resources/subscribe. */
const subscribedResources = new Set<string>();

/** @brief Handle for the IPC directory watcher, started lazily on first subscribe. */
let ipcWatcher: fs.FSWatcher | null = null;

/** @brief Pending debounce timers for resource-updated notifications, keyed by URI. */
const resourceNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * @brief Watch the IPC directory and forward file changes as
 * `notifications/resources/updated` for subscribed resources.
 *
 * Notifications are debounced per URI (250 ms) because the console log in
 * particular can be appended to many times per second.
 */
function ensureIpcWatcher(): void {
  if (ipcWatcher) { return; }
  let dir: string;
  try {
    dir = getIpcDir();
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    ipcWatcher = fs.watch(dir, (_event, fileName) => {
      if (!fileName) { return; }
      for (const [uri, backingFile] of Object.entries(SUBSCRIBABLE_RESOURCES)) {
        if (backingFile !== fileName || !subscribedResources.has(uri)) { continue; }
        if (resourceNotifyTimers.has(uri)) { continue; }
        resourceNotifyTimers.set(uri, setTimeout(() => {
          resourceNotifyTimers.delete(uri);
          if (!subscribedResources.has(uri) || !server.isConnected()) { return; }
          void server.server.sendResourceUpdated({ uri }).catch(() => { /* ignore */ });
        }, 250));
      }
    });
    ipcWatcher.on('error', (err) => {
      debug(`ipcWatcher error: ${err instanceof Error ? err.message : String(err)}`);
      ipcWatcher = null;
    });
    debug(`ipcWatcher: watching ${dir}`);
  } catch (err) {
    debug(`ensureIpcWatcher failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (!(uri in SUBSCRIBABLE_RESOURCES)) {
    throw new Error(`Resource does not support subscriptions: ${uri}`);
  }
  subscribedResources.add(uri);
  ensureIpcWatcher();
  debug(`resources/subscribe: ${uri}`);
  return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscribedResources.delete(request.params.uri);
  debug(`resources/unsubscribe: ${request.params.uri}`);
  return {};
});

// ============================================================================
// Prompts
// ============================================================================
//
// Reusable prompt templates exposed by MCP clients as slash commands
// (VS Code: /mcp.openblink.<prompt-name>).
//
// The prompt texts are written to work with ANY MCP-capable model, not just
// a specific IDE assistant. They therefore spell out the exact tool names
// and arguments, the domain constraints of mruby/c on microcontrollers,
// success criteria, bounded retry loops, and explicit stop conditions —
// nothing is assumed to be known from prior context.

/**
 * @brief Shared context block prepended to every prompt.
 *
 * Gives any model — regardless of vendor or prior exposure to OpenBlink —
 * the minimum domain knowledge needed to use the tools correctly.
 */
const PROMPT_CONTEXT = [
  '## Context',
  'OpenBlink deploys mruby (embedded Ruby) programs to a microcontroller over Bluetooth Low Energy.',
  'You control it exclusively through the MCP tools of the "OpenBlink" server; there is no shell or serial port.',
  '',
  'Hard constraints — violating any of these produces broken or undeployable programs:',
  '- The target runs mruby/c, a small subset of Ruby: no gems, no require, no File/IO/Net/Thread, no String#format edge cases. Prefer simple loops, integers, and basic String/Array/Hash usage.',
  '- Hardware APIs (LED, buttons, timers, etc.) differ per board. The ONLY authoritative API list is the get_board_reference tool (also available as the openblink://board/reference resource). Never invent or assume a method that is not documented there.',
  '- Compiled bytecode must stay small (roughly 15 KB); keep programs short and avoid large literals.',
  '- Long-running programs must be an explicit loop with a sleep inside (e.g. `while true; ...; sleep 0.1; end`); a program that falls off the end simply stops.',
  '- Tools that talk to hardware (scan_devices, connect_device, build_and_blink, soft_reset) can fail transiently. Retry at most twice, then stop and report the failure instead of looping.',
  '',
  '## Reporting',
  'When you finish (success or failure), report: what was deployed/changed, the tool results you observed (compile/transfer times, console output), and any remaining problems with a concrete next step for the user.',
].join('\n');

server.registerPrompt('deploy-and-debug', {
  title: 'Deploy & Debug',
  description: 'Compile the current mruby program, transfer it to the connected OpenBlink device, and verify it runs correctly.',
  argsSchema: {
    file: z.string().optional().describe(
      'Workspace-relative path to the .rb source file. If omitted, the configured openblink.sourceFile is used.'
    ),
    expected_behavior: z.string().optional().describe(
      'What the program should do once running (used to verify the console output). Optional.'
    ),
  },
}, ({ file, expected_behavior }) => ({
  messages: [{
    role: 'user' as const,
    content: {
      type: 'text' as const,
      text: [
        PROMPT_CONTEXT,
        '',
        '## Task',
        `Deploy ${file ? `the mruby program "${file}"` : 'the configured mruby program (openblink.sourceFile setting)'} to the OpenBlink device and verify it works.`,
        ...(expected_behavior ? [`Expected behavior once running: ${expected_behavior}`] : []),
        '',
        '## Procedure',
        '1. Call get_device_info. If state is not "connected": call scan_devices, then connect_device with the deviceId of the discovered OpenBlink device. If several devices are found and the choice is ambiguous, list them and ask the user rather than guessing.',
        `2. Call validate_ruby_code${file ? ` with file "${file}"` : ''}. If it reports syntax errors, fix them in the source file first (minimal edits) and re-validate.`,
        `3. Call build_and_blink${file ? ` with file "${file}"` : ''}. On success note compileTime, transferTime, and programSize. If the result says compiledWithoutTransfer, the code is fine but no device was connected — go back to step 1.`,
        '4. If the build fails: call get_build_diagnostics, fix exactly the reported errors (line/column are given), re-validate, and retry the build. Maximum 3 fix-and-retry cycles; after that stop and report what still fails.',
        '5. After a successful transfer, wait a moment, then call get_console_output.' + (expected_behavior ? ' Compare the output against the expected behavior above.' : ' Check for runtime errors or unexpected silence.'),
        '6. If the console shows a runtime error, fix the code and repeat from step 2 (this also counts toward the 3-cycle limit).',
        '',
        '## Success criteria',
        'build_and_blink reported success with a transfer, and the console output shows the program running' + (expected_behavior ? ' with the expected behavior.' : ' without errors.'),
      ].join('\n'),
    },
  }],
}));

server.registerPrompt('fix-build-errors', {
  title: 'Fix Build Errors',
  description: 'Diagnose the most recent failed OpenBlink build and fix the errors in the source file.',
  argsSchema: {},
}, () => ({
  messages: [{
    role: 'user' as const,
    content: {
      type: 'text' as const,
      text: [
        PROMPT_CONTEXT,
        '',
        '## Task',
        'The last OpenBlink build failed. Diagnose the failure and fix the source file so it builds and runs.',
        '',
        '## Procedure',
        '1. Call get_build_diagnostics. It returns the failing file plus each error\'s line, column, message, and (when available) a suggested fix. If it reports no diagnostics, call get_build_status to check whether a build ever ran, and report that instead of guessing.',
        '2. Call get_board_reference BEFORE editing. Many "build" failures are actually calls to methods the selected board does not provide — verify every hardware API used by the source against the reference.',
        '3. Fix exactly the reported problems with minimal edits. Do not restructure working code, rename identifiers, or "improve" style while fixing errors.',
        '4. Verify with validate_ruby_code, then rebuild with build_and_blink.',
        '5. If the build fails again with NEW errors, repeat from step 1. If it fails with the SAME errors twice, stop and report the diagnostics verbatim — do not keep guessing.',
        '6. On success, call get_console_output to confirm the program runs without runtime errors.',
        '',
        '## Success criteria',
        'build_and_blink succeeds and the console output shows no errors.',
      ].join('\n'),
    },
  }],
}));

server.registerPrompt('write-board-program', {
  title: 'Write Board Program',
  description: 'Write a new mruby program for the currently selected OpenBlink board using only its documented APIs.',
  argsSchema: {
    task: z.string().describe('What the program should do (e.g. "blink the LED red and blue alternately every 500 ms").'),
  },
}, ({ task }) => ({
  messages: [{
    role: 'user' as const,
    content: {
      type: 'text' as const,
      text: [
        PROMPT_CONTEXT,
        '',
        '## Task',
        `Write an mruby program for the currently selected OpenBlink board that does the following: ${task}`,
        '',
        '## Procedure',
        '1. Call get_board_reference FIRST and read it fully. Use ONLY the classes and methods documented there. If the task requires a capability the board does not document (e.g. it asks for sound but the board has no speaker API), say so and propose the closest achievable alternative instead of inventing an API.',
        '2. Write the program: keep it small, use an explicit `while true ... end` loop with a sleep for continuous behavior, and add a short `puts` at startup so the console proves the program is alive.',
        '3. Validate with validate_ruby_code (pass the code directly via the code parameter, or the file if you saved one). Fix any syntax errors.',
        '4. Ensure a device is connected (get_device_info; scan_devices + connect_device if not), then deploy with build_and_blink.',
        '5. Verify with get_console_output that the startup message appears and the behavior matches the task. Fix and redeploy if needed (maximum 3 cycles).',
        '',
        '## Success criteria',
        'The program is deployed, the console shows the startup message, and the observed behavior matches the task description.',
      ].join('\n'),
    },
  }],
}));

server.registerPrompt('troubleshoot-connection', {
  title: 'Troubleshoot BLE Connection',
  description: 'Systematically diagnose why the OpenBlink device cannot be found or connected over BLE.',
  argsSchema: {},
}, () => ({
  messages: [{
    role: 'user' as const,
    content: {
      type: 'text' as const,
      text: [
        PROMPT_CONTEXT,
        '',
        '## Task',
        'The OpenBlink device cannot be found or the BLE connection keeps failing. Diagnose the problem step by step and either fix it or tell the user exactly what to do.',
        '',
        '## Procedure',
        '1. Call get_device_info to capture the current state (disconnected / connecting / connected) and note any deviceName/MTU from a previous session.',
        '2. Call scan_devices with timeout 15000. Three possible outcomes:',
        '   a. No devices found → the problem is on the device/host side. Tell the user to check, in this order: the device is powered on; the device firmware is an OpenBlink build (it must advertise the OpenBlink BLE service); the device is within a few meters; Bluetooth is enabled on this computer; no other host (phone/other laptop) is currently connected to the device, since OpenBlink devices accept only one connection.',
        '   b. Devices found but connect_device fails → retry connect_device once with timeout 30000. If it still fails, report the exact error text from the tool and suggest power-cycling the device.',
        '   c. Scan itself errors → the local Bluetooth stack is the problem. Report the error text; on Linux mention that the extension needs Bluetooth permissions (e.g. setcap on the VS Code binary or running with appropriate privileges).',
        '3. After any successful connect_device, confirm with get_device_info (state must be "connected" and MTU > 0), then run soft_reset only if the user reports the device is unresponsive despite being connected.',
        '4. Summarize: what was tried, what the tools returned verbatim, the most likely root cause, and the single next action for the user.',
        '',
        '## Constraints',
        'Never claim the device is broken based on one failed attempt. Never retry the same failing tool more than twice.',
      ].join('\n'),
    },
  }],
}));

// ============================================================================
// Start Server
// ============================================================================

// Guard against unhandled errors crashing the MCP server process silently.
// These handlers log to stderr (visible in the MCP client's error stream)
// and then exit, since the process may be in a corrupt state after an
// uncaught exception (per Node.js docs).
process.on('uncaughtException', (error) => {
  const detail = error instanceof Error && error.stack ? error.stack : String(error);
  process.stderr.write(`OpenBlink MCP server uncaught exception: ${detail}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error && reason.stack ? reason.stack : String(reason);
  process.stderr.write(`OpenBlink MCP server unhandled rejection: ${detail}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  // Validate IPC directory early so any misconfiguration (missing env var,
  // relative path, non-existent directory) is surfaced at startup rather
  // than on the first tool invocation.
  try {
    const dir = getIpcDir();
    debug(`starting with OPENBLINK_IPC_DIR=${dir}`);
    if (!fs.existsSync(dir)) {
      debug(`IPC directory does not exist yet (will be created by extension): ${dir}`);
    }
  } catch (err) {
    process.stderr.write(`OpenBlink MCP server: ${errorMessage(err)}\n`);
    process.stderr.write('OpenBlink MCP server: set OPENBLINK_IPC_DIR to an absolute path pointing at the extension\'s IPC directory.\n');
    process.exit(1);
  }

  debug(`starting MCP server (version=${EXTENSION_VERSION}, debug=${DEBUG})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug('MCP server ready (stdio transport connected)');
}

main().catch((error) => {
  process.stderr.write(`OpenBlink MCP server error: ${error}\n`);
  process.exit(1);
});
