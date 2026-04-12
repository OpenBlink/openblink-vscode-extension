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
 *   - Writes `trigger.json` to request a Build & Blink.
 *   - Reads  `result.json`  for the build outcome.
 *
 * Registered MCP tools:
 *   1. `build_and_blink` — Compile a .rb file and transfer via BLE.
 *   2. `get_device_info`  — Return the current device connection state.
 *   3. `get_console_output` — Return recent device console output.
 *   4. `get_metrics`     — Return build/transfer metrics and statistics.
 *   5. `get_board_reference` — Return the board API reference (Markdown).
 *
 * @see https://modelcontextprotocol.io/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

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
  return path.join(workspace, '.openblink');
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

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: 'OpenBlink',
  version: EXTENSION_VERSION,
});

// ----------------------------------------------------------------------------
// Tool: build_and_blink
// ----------------------------------------------------------------------------

server.tool(
  'build_and_blink',
  'Compile a Ruby (.rb) file with mruby and transfer the bytecode to a BLE-connected OpenBlink device. ' +
  'Call this after editing a .rb file to deploy changes to the hardware. ' +
  'Returns compile time, transfer time, program size, and success/error status. ' +
  'Requires an OpenBlink device to be connected via BLE for transfer (compilation works without a device).',
  {
    file: z.string().optional().describe(
      'Path to the .rb source file relative to the workspace root. ' +
      'If omitted, the configured openblink.sourceFile setting is used (default: app.rb).'
    ),
  },
  async ({ file }) => {
    const dir = getIpcDir();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Write trigger file
    const trigger = { file, requestId };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trigger.json'), JSON.stringify(trigger, null, 2), 'utf-8');

    // Poll for result (max 30 seconds)
    const resultPath = path.join(dir, 'result.json');
    const timeout = 30_000;
    const poll = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, poll));
      const result = readJsonFile<{
        requestId: string;
        success: boolean;
        compileTime?: number;
        transferTime?: number;
        programSize?: number;
        error?: string;
      }>(resultPath);

      if (result && result.requestId === requestId) {
        // Clean up result file
        try { fs.unlinkSync(resultPath); } catch { /* ignore */ }

        if (result.success) {
          const parts = [
            `Build & Blink completed successfully.`,
            result.compileTime !== undefined ? `Compile time: ${result.compileTime.toFixed(1)} ms` : null,
            result.transferTime !== undefined ? `Transfer time: ${result.transferTime.toFixed(1)} ms` : null,
            result.programSize !== undefined ? `Program size: ${result.programSize} bytes` : null,
          ].filter(Boolean);
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
        } else {
          return {
            content: [{ type: 'text' as const, text: `Build & Blink failed: ${result.error ?? 'Unknown error'}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'Build & Blink timed out after 30 seconds. Is the OpenBlink extension running?' }],
      isError: true,
    };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_device_info
// ----------------------------------------------------------------------------

server.tool(
  'get_device_info',
  'Get the current BLE connection state and device information for the connected OpenBlink device. ' +
  'Returns connection state (disconnected/connecting/connected/reconnecting), device name, device ID, and negotiated MTU.',
  {},
  async () => {
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

server.tool(
  'get_console_output',
  'Get recent console output from the connected OpenBlink device. ' +
  'Returns up to 100 lines of the most recent [DEVICE] log messages. ' +
  'Use this to see runtime output, debug prints, and error messages from the mruby/c program running on the device.',
  {
    lines: z.number().optional().describe(
      'Maximum number of lines to return (default: all available, up to 100).'
    ),
  },
  async ({ lines: maxLines }) => {
    const dir = getIpcDir();
    const raw = readTextFile(path.join(dir, 'openblink-console.log'));

    if (!raw || raw.trim().length === 0) {
      return { content: [{ type: 'text' as const, text: 'No console output available.' }] };
    }

    let logLines = raw.split('\n').filter(l => l.length > 0);
    if (maxLines !== undefined && maxLines > 0) {
      logLines = logLines.slice(-maxLines);
    }

    return { content: [{ type: 'text' as const, text: logLines.join('\n') }] };
  },
);

// ----------------------------------------------------------------------------
// Tool: get_metrics
// ----------------------------------------------------------------------------

server.tool(
  'get_metrics',
  'Get build and transfer metrics for the OpenBlink extension. ' +
  'Returns the latest compile time, transfer time, program size, and min/avg/max statistics across recent builds.',
  {},
  async () => {
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

server.tool(
  'get_board_reference',
  'Get the API reference documentation (Markdown) for the currently selected OpenBlink board. ' +
  'Returns the board name and the full reference Markdown content describing available APIs ' +
  '(LED, GPIO, Sleep, etc.) that can be used in mruby programs.',
  {},
  async () => {
    const dir = getIpcDir();
    const status = readJsonFile<{
      board: { name: string; displayName: string; referencePath: string } | null;
    }>(path.join(dir, 'status.json'));

    if (!status?.board) {
      return { content: [{ type: 'text' as const, text: 'No board selected. Use the OpenBlink sidebar to select a board.' }] };
    }

    const refContent = readTextFile(status.board.referencePath);
    if (!refContent) {
      return { content: [{ type: 'text' as const, text: `Board "${status.board.displayName}" selected, but reference file not found at: ${status.board.referencePath}` }] };
    }

    return { content: [{ type: 'text' as const, text: `# ${status.board.displayName}\n\n${refContent}` }] };
  },
);

// ============================================================================
// Start Server
// ============================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`OpenBlink MCP server error: ${error}\n`);
  process.exit(1);
});
