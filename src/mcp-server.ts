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
 * `.openblink/` directory at the workspace root (file-based IPC):
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
 * @see https://modelcontextprotocol.io/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

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
 * @brief Resolve the `.openblink/` IPC directory path.
 *
 * The workspace root is passed as the `OPENBLINK_WORKSPACE` environment
 * variable by the extension when it launches the MCP server.
 */
function getIpcDir(): string {
  const workspace = process.env.OPENBLINK_WORKSPACE;
  if (!workspace) {
    throw new Error('OPENBLINK_WORKSPACE environment variable is not set');
  }
  // Reject relative paths before resolving to prevent path traversal
  if (!path.isAbsolute(workspace)) {
    throw new Error('OPENBLINK_WORKSPACE must be an absolute path');
  }
  const resolved = path.resolve(workspace);
  return path.join(resolved, '.openblink');
}

/** @brief Safely read and parse a JSON file.  Returns `null` on any error. */
function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** @brief Safely read a text file.  Returns `null` on any error. */
function readTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) { return null; }
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** @brief Safely write a JSON file to the IPC directory. */
function writeJsonFile<T>(filePath: string, data: T): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** @brief Poll for a result file with timeout and optional cancellation check. */
async function pollForResult<T>(
  resultPath: string,
  timeout: number,
  pollInterval: number,
  requestId: string,
  idField: keyof T,
  isCancelled?: () => boolean,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isCancelled?.()) {
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    const result = readJsonFile<T>(resultPath);
    if (result && (result[idField] as unknown) === requestId) {
      try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
      return result;
    }
  }
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
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: 'OpenBlink',
  version: EXTENSION_VERSION,
}, {
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
    '- get_device_info — BLE connection status, MTU, device name',
});

// ----------------------------------------------------------------------------
// Tool: build_and_blink
// ----------------------------------------------------------------------------

server.registerTool('build_and_blink', {
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
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async ({ file, timeout: customTimeout }) => {
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
      const msg = error instanceof Error ? error.message : String(error);
      return formatErrorResponse(
        createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg)
      );
    }

    const requestId = `build_${randomUUID()}`;
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
        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
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
  description:
    'Get the current BLE connection state and device information for the connected OpenBlink device. ' +
    'Returns connection state (disconnected/connecting/connected/reconnecting), device name, device ID, and negotiated MTU. ' +
    'Call this to check if a device is connected before running build_and_blink.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
    const status = readJsonFile<{ connection: { state: string; deviceName: string | null; deviceId: string | null; mtu: number } }>(
      path.join(dir, 'status.json'),
    );

    if (!status) {
      return { content: [{ type: 'text' as const, text: 'No status available. Is the OpenBlink extension running with MCP enabled?' }] };
    }

    const c = status.connection;
    const lines = [
      `Connection state: ${c.state}`,
      `Device name: ${c.deviceName ?? '(none)'}`,
      `Device ID: ${c.deviceId ?? '(none)'}`,
      `MTU: ${c.mtu}`,
    ];
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_console_output
// ----------------------------------------------------------------------------

server.registerTool('get_console_output', {
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
    const raw = readTextFile(path.join(dir, 'openblink-console.log'));

    if (!raw || raw.trim().length === 0) {
      return { content: [{ type: 'text' as const, text: 'No console output available.' }] };
    }

    let logLines = raw.split('\n').filter(l => l.length > 0);
    const cap = (maxLines !== undefined && maxLines > 0) ? maxLines : 100;
    logLines = logLines.slice(-cap);

    return { content: [{ type: 'text' as const, text: logLines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_metrics
// ----------------------------------------------------------------------------

server.registerTool('get_metrics', {
  description:
    'Get cumulative build and transfer metrics for the OpenBlink extension. ' +
    'Returns the latest compile time, transfer time, program size, and min/avg/max statistics across recent builds. ' +
    'Unlike build_and_blink (which returns only the current build metrics), this shows historical performance trends.',
  inputSchema: {},
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
      return { content: [{ type: 'text' as const, text: 'No metrics available. Is the OpenBlink extension running with MCP enabled?' }] };
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
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_board_reference
// ----------------------------------------------------------------------------

server.registerTool('get_board_reference', {
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
    const status = readJsonFile<{
      board: { name: string; displayName: string; referencePath: string } | null;
    }>(path.join(dir, 'status.json'));

    if (!status?.board) {
      return { content: [{ type: 'text' as const, text: 'No board selected. Use the OpenBlink sidebar to select a board.' }] };
    }

    // Validate referencePath to prevent arbitrary file reads via a tampered status.json.
    // 1. Must not contain any '..' path components.
    // 2. Must be a Markdown file (.md) to restrict to documentation.
    // 3. Must reside inside the extension directory (OPENBLINK_EXTENSION_DIR).
    const referencePathInput = status.board.referencePath;
    const normalizedRefPath = path.normalize(referencePathInput);
    const refPathSegments = normalizedRefPath
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0);
    const refPath = path.resolve(referencePathInput);
    if (refPathSegments.includes('..') || path.extname(refPath).toLowerCase() !== '.md') {
      return { content: [{ type: 'text' as const, text: `Board reference path is invalid or not a Markdown file.` }], isError: true };
    }
    const extensionDir = process.env.OPENBLINK_EXTENSION_DIR;
    if (!extensionDir) {
      return { content: [{ type: 'text' as const, text: `Extension directory is not configured. Cannot verify board reference path.` }], isError: true };
    }
    const resolvedExtensionDir = path.resolve(extensionDir);
    const relativeRefPath = path.relative(resolvedExtensionDir, refPath);
    if (relativeRefPath === '..' || relativeRefPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRefPath)) {
      return { content: [{ type: 'text' as const, text: `Board reference path is outside the extension directory.` }], isError: true };
    }
    const refContent = readTextFile(refPath);
    if (!refContent) {
      return { content: [{ type: 'text' as const, text: `Board "${status.board.displayName}" selected, but reference file not found at: ${refPath}` }] };
    }

    // Truncate to protect AI context window from excessively large reference files.
    const MAX_REF_SIZE = 50_000;
    const safeContent = refContent.length > MAX_REF_SIZE
      ? refContent.slice(0, MAX_REF_SIZE) + '\n\n[Truncated — content exceeds 50 KB limit]'
      : refContent;
    return { content: [{ type: 'text' as const, text: `# ${status.board.displayName}\n\n${safeContent}` }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: validate_ruby_code
// ----------------------------------------------------------------------------

server.registerTool('validate_ruby_code', {
  description:
    'Validate Ruby syntax without compiling or transferring to a device. ' +
    'This is a lightweight check that catches syntax errors quickly without requiring a BLE connection. ' +
    'Use this before build_and_blink to catch errors early. ' +
    'Returns syntax validation result and any error messages.',
  inputSchema: {
    file: z.string().min(1).optional().describe(
      'Path to the .rb source file relative to the workspace root. ' +
      'If omitted, the configured openblink.sourceFile setting is used.'
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
      const msg = error instanceof Error ? error.message : String(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `validate_${randomUUID()}`;
    registerOperation(requestId);

    try {
      // Write validation trigger
      const trigger = {
        type: 'validate',
        requestId,
        file,
        code,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'trigger.json'), trigger)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write validation trigger'));
      }

      // Poll for result
      const resultPath = path.join(dir, 'result.json');
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
  description:
    'Scan for nearby BLE devices that support OpenBlink. ' +
    'Returns a list of discovered devices with their names and IDs. ' +
    'Use this to find devices to connect to. The scan runs for approximately 10 seconds.',
  inputSchema: {
    timeout: z.number().int().min(3000).max(30000).optional().describe(
      'Scan duration in milliseconds (default: 10000, min: 3000, max: 30000)'
    ),
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
      const msg = error instanceof Error ? error.message : String(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
    }

    const requestId = `scan_${randomUUID()}`;
    registerOperation(requestId);

    try {
      // Write scan command
      const command = {
        type: 'scan',
        requestId,
        timeout: customTimeout ?? 10000,
        timestamp: new Date().toISOString(),
      };

      if (!writeJsonFile(path.join(dir, 'command.json'), command)) {
        return formatErrorResponse(createError(ErrorCode.FILE_ACCESS_DENIED, 'Failed to write scan command'));
      }

      // Poll for command result
      const resultPath = path.join(dir, 'command-result.json');
      const timeout = (customTimeout ?? 10000) + 5000; // Scan time + buffer

      const result = await pollForResult<{
        requestId: string;
        success: boolean;
        devices?: Array<{ id: string; name: string; rssi?: number }>;
        error?: string;
      }>(resultPath, timeout, 200, requestId, 'requestId', () => isOperationCancelled(requestId));

      if (isOperationCancelled(requestId)) {
        return formatErrorResponse(createError(ErrorCode.OPERATION_CANCELLED, 'Scan was cancelled'));
      }

      if (!result) {
        return formatErrorResponse(createError(ErrorCode.TIMEOUT, 'Scan timed out'));
      }

      if (result.success && result.devices) {
        if (result.devices.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No OpenBlink devices found nearby. Ensure the device is powered on and in range.' }] };
        }
        const lines = [
          `Found ${result.devices.length} device(s):`,
          ...result.devices.map(d => `  - ${d.name} (ID: ${d.id}${d.rssi !== undefined ? `, RSSI: ${d.rssi}dBm` : ''})`),
          '',
          'Use connect_device with the device ID to connect.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
  description:
    'Connect to an OpenBlink BLE device by its ID. ' +
    'The device ID must be obtained from scan_devices first. ' +
    'After connecting, use get_device_info to verify the connection.',
  inputSchema: {
    deviceId: z.string().min(1).describe('The BLE device ID from scan_devices'),
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
    if (!deviceId) {
      return formatErrorResponse(createError(ErrorCode.INVALID_PARAMETER, 'deviceId is required'));
    }

    let dir: string;
    try {
      dir = getIpcDir();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return formatErrorResponse(createError(ErrorCode.NOT_INITIALIZED, 'Extension not initialized', msg));
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
      const msg = error instanceof Error ? error.message : String(error);
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
  description:
    'Execute a soft reset on the connected OpenBlink device. ' +
    'This restarts the mruby/c program on the device without disconnecting BLE. ' +
    'Use this after build_and_blink to restart the program, or to recover from errors.',
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
      const msg = error instanceof Error ? error.message : String(error);
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
  description:
    'Get detailed diagnostic information about the most recent build failure. ' +
    'Returns syntax errors, line numbers, column positions, and suggested fixes. ' +
    'Use this after build_and_blink fails to understand what went wrong.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
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
      return { content: [{ type: 'text' as const, text: 'No build diagnostics available. Run build_and_blink first.' }] };
    }

    if (diagnostics.success) {
      return { content: [{ type: 'text' as const, text: `Last build (${diagnostics.file}) was successful.` }] };
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

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_build_status
// ----------------------------------------------------------------------------

server.registerTool('get_build_status', {
  description:
    'Check the current status of the build system. ' +
    'Returns whether a build is in progress, the last build result, and queue information. ' +
    'Use this to check if you can start a new build or to see if a previous build completed.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, async () => {
    const dir = getIpcDir();
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
        return { content: [{ type: 'text' as const, text: 'No build status available. Is the extension running?' }] };
      }

      const lines = ['Build Status:'];
      if (basicStatus.lastBuild) {
        lines.push(`  Last build: ${basicStatus.lastBuild.success ? 'Success' : 'Failed'} at ${basicStatus.lastBuild.timestamp}`);
      } else {
        lines.push('  No builds have been run yet.');
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: cancel_build
// ----------------------------------------------------------------------------

server.registerTool('cancel_build', {
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
      const msg = error instanceof Error ? error.message : String(error);
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`OpenBlink MCP server error: ${error}\n`);
  process.exit(1);
});
