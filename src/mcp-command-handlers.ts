/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { compile } from './compiler';
import { sendReset } from './protocol';
import * as ui from './ui-manager';
import * as mcpBridge from './mcp-bridge';
import { ExtensionState } from './extension-state';
import { buildAndBlink } from './build-pipeline';
import { errorMessage } from './error-utils';

export async function handleMcpBuildTrigger(state: ExtensionState, filePath: string, requestId: string): Promise<void> {
    const startTime = Date.now();
    const summary = path.basename(filePath);
    ui.log(`[MCP] build_and_blink received: ${summary} (${requestId})`);
    state.mcpStatusProvider.addHistoryEntry({ tool: 'build_and_blink', requestId, summary });
    state.mcpStatusProvider.update({ lastTriggerTime: new Date(), lastTriggerRequestId: requestId });

    // Mark build as started
    mcpBridge.markBuildStarted(requestId, filePath);

    try {
      const sourceUri = vscode.Uri.file(filePath);
      const buildResult = await buildAndBlink(state, sourceUri, { silent: true, requestId });
      const durationMs = Date.now() - startTime;

      // Write build result for MCP server to consume
      const history = ui.getMetricsHistory();
      const lastCompile = history.compile.length > 0 ? history.compile[history.compile.length - 1] : undefined;
      const lastTransfer = history.transfer.length > 0 ? history.transfer[history.transfer.length - 1] : undefined;
      const lastSize = history.size.length > 0 ? history.size[history.size.length - 1] : undefined;

      const compiledWithoutTransfer = !buildResult.success && buildResult.error?.includes('not connected') && lastCompile !== undefined;
      mcpBridge.writeBuildResult({
        requestId,
        success: buildResult.success,
        compileTime: compiledWithoutTransfer ? lastCompile : (buildResult.success ? lastCompile : undefined),
        transferTime: buildResult.success ? lastTransfer : undefined,
        programSize: compiledWithoutTransfer ? lastSize : (buildResult.success ? lastSize : undefined),
        error: buildResult.error,
        compiledWithoutTransfer: compiledWithoutTransfer || undefined,
      });
      state.mcpStatusProvider.update({
        lastResultTime: new Date(),
        lastResultSuccess: buildResult.success,
        lastResultError: buildResult.error,
      });

      // Record outcome in the history view and log
      const detail = buildResult.success
        ? [
            lastCompile !== undefined ? `compile ${lastCompile.toFixed(1)}ms` : undefined,
            lastTransfer !== undefined ? `transfer ${lastTransfer.toFixed(1)}ms` : undefined,
            lastSize !== undefined ? `size ${lastSize}B` : undefined,
          ].filter(Boolean).join(', ')
        : buildResult.error;
      state.mcpStatusProvider.updateHistoryEntry(requestId, {
        status: buildResult.success ? 'success' : 'failed',
        detail: detail || undefined,
        durationMs,
      });
      ui.log(`[MCP] build_and_blink ${buildResult.success ? 'completed' : 'failed'} in ${durationMs}ms${detail ? ` (${detail})` : ''}`);

      // Mark build as completed
      mcpBridge.markBuildCompleted(requestId, buildResult.success);
    } catch (error) {
      const msg = errorMessage(error);
      const durationMs = Date.now() - startTime;
      mcpBridge.writeBuildResult({ requestId, success: false, error: msg });
      state.mcpStatusProvider.update({ lastResultTime: new Date(), lastResultSuccess: false, lastResultError: msg });
      mcpBridge.markBuildCompleted(requestId, false);
      state.mcpStatusProvider.updateHistoryEntry(requestId, { status: 'failed', detail: msg, durationMs });
      ui.log(`[MCP] build_and_blink threw in ${durationMs}ms: ${msg}`);
    }
  }

export async function handleMcpCommand(state: ExtensionState, command: mcpBridge.McpCommand): Promise<void> {
  const summary = summarizeMcpCommand(command);
  ui.log(`[MCP] ${command.type} received${summary ? ` (${summary})` : ''} (${command.requestId})`);
  state.mcpStatusProvider.addHistoryEntry({ tool: command.type, requestId: command.requestId, summary });
  switch (command.type) {
    case 'scan': await handleMcpScanCommand(state, command); break;
    case 'connect': await handleMcpConnectCommand(state, command); break;
    case 'disconnect': await handleMcpDisconnectCommand(state, command); break;
    case 'reset': await handleMcpResetCommand(state, command); break;
    case 'cancel': await handleMcpCancelCommand(state, command); break;
    case 'validate': await handleMcpValidateCommand(state, command); break;
    default: { const unknownType = (command as { type: string }).type; ui.log(`[MCP] Unknown command type: ${unknownType}`); state.mcpStatusProvider.updateHistoryEntry(command.requestId, { status: 'failed', detail: `Unknown command type: ${unknownType}` }); }
  }
}

function summarizeMcpCommand(command: mcpBridge.McpCommand): string {
  switch (command.type) {
    case 'scan':
      return command.timeout !== undefined ? `timeout=${command.timeout}ms` : '';
    case 'connect':
      return command.deviceId ? `deviceId=${command.deviceId}` : '';
    case 'disconnect':
      return command.force ? 'force' : '';
    case 'reset':
      return command.slot !== undefined ? `slot=${command.slot}` : '';
    case 'cancel':
      return command.targetRequestId ? `target=${command.targetRequestId}` : '';
    case 'validate':
      if (command.code) { return 'inline code'; }
      return command.file ?? '';
    default:
      return '';
  }
}

/**
 * @brief Publish an MCP command result to the bridge, history view, and log.
 *
 * Centralises the three side-effects that every command handler performs
 * upon completion:
 *   1. Atomic `command-result.json` write (via the bridge).
 *   2. Update of the MCP Status tree view's history entry.
 *   3. Single `[MCP]` line in the output channel.
 *
 * @param toolName   Name of the tool as shown in the UI (matches the MCP
 *                   tool name, e.g. `scan`, `connect_device`).
 * @param result     The command outcome to write.
 * @param startTime  `Date.now()` captured when the command was received.
 * @param detail     Optional success detail (e.g. device list summary).
 */
function reportMcpCommandResult(
  state: ExtensionState,
  toolName: string,
  result: mcpBridge.McpCommandResult,
  startTime: number,
  detail?: string,
): void {
  const durationMs = Date.now() - startTime;
  mcpBridge.writeCommandResult(result);
  state.mcpStatusProvider.updateHistoryEntry(result.requestId, {
    status: result.success ? 'success' : 'failed',
    detail: result.success ? detail : (result.error ?? detail),
    durationMs,
  });
  const extra = result.success
    ? (detail ? ` (${detail})` : '')
    : (result.error ? ` (${result.error})` : '');
  ui.log(`[MCP] ${toolName} ${result.success ? 'completed' : 'failed'} in ${durationMs}ms${extra}`);
}

/**
 * @brief Handle MCP scan command.
 */
async function handleMcpScanCommand(state: ExtensionState, command: { requestId: string; timeout?: number }): Promise<void> {
  const startTime = Date.now();

  try {
    // Start scan (BleManager also sets its own auto-stop timer)
    await state.bleManager.startScan();

    // Wait until BleManager's auto-stop fires or the requested timeout elapses,
    // whichever comes first — avoids the dual-timer issue where the MCP timeout
    // and BleManager's internal scan timeout could conflict.
    const scanTimeout = command.timeout ?? 10000;
    await state.bleManager.waitForScanCompletion({ timeoutMs: scanTimeout });

    // Ensure scan is fully stopped
    await state.bleManager.stopScan();

    // Collect discovered devices
    const devices: Array<{ id: string; name: string; rssi?: number }> = [];
    for (const [id, info] of state.bleManager.discoveredDevices.entries()) {
      devices.push({ id, name: info.name, rssi: undefined });
    }

    reportMcpCommandResult(state, 'scan', {
      requestId: command.requestId,
      success: true,
      devices,
    }, startTime, `${devices.length} device(s)`);
  } catch (error) {
    const msg = errorMessage(error);
    reportMcpCommandResult(state, 'scan', {
      requestId: command.requestId,
      success: false,
      error: msg,
    }, startTime);
  }
}

/**
 * @brief Handle MCP connect command.
 */
async function handleMcpConnectCommand(state: ExtensionState, command: { requestId: string; deviceId?: string; timeout?: number }): Promise<void> {
  const startTime = Date.now();
  if (!command.deviceId) {
    reportMcpCommandResult(state, 'connect', {
      requestId: command.requestId,
      success: false,
      error: 'deviceId is required',
    }, startTime);
    return;
  }

  try {
    await state.bleManager.connectById(command.deviceId);

    reportMcpCommandResult(state, 'connect', {
      requestId: command.requestId,
      success: true,
      deviceName: state.bleManager.deviceName ?? undefined,
      mtu: state.bleManager.negotiatedMTU,
    }, startTime, `${state.bleManager.deviceName ?? command.deviceId}, MTU=${state.bleManager.negotiatedMTU}`);
  } catch (error) {
    const msg = errorMessage(error);
    reportMcpCommandResult(state, 'connect', {
      requestId: command.requestId,
      success: false,
      error: msg,
    }, startTime);
  }
}

/**
 * @brief Handle MCP disconnect command.
 */
async function handleMcpDisconnectCommand(state: ExtensionState, command: { requestId: string }): Promise<void> {
  const startTime = Date.now();

  try {
    await state.bleManager.disconnect();

    reportMcpCommandResult(state, 'disconnect', {
      requestId: command.requestId,
      success: true,
    }, startTime);
  } catch (error) {
    const msg = errorMessage(error);
    reportMcpCommandResult(state, 'disconnect', {
      requestId: command.requestId,
      success: false,
      error: msg,
    }, startTime);
  }
}

/**
 * @brief Handle MCP reset command.
 */
async function handleMcpResetCommand(state: ExtensionState, command: { requestId: string; slot?: number }): Promise<void> {
  const startTime = Date.now();

  const programChar = state.bleManager.getProgramCharacteristic();
  if (!state.bleManager.isConnected || !programChar) {
    reportMcpCommandResult(state, 'reset', {
      requestId: command.requestId,
      success: false,
      error: 'Device is not connected',
    }, startTime);
    return;
  }

  try {
    const resetSlot = command.slot ?? state.currentSlot;
    await sendReset(programChar, (msg) => ui.log(msg), resetSlot);

    reportMcpCommandResult(state, 'reset', {
      requestId: command.requestId,
      success: true,
    }, startTime, `slot ${resetSlot}`);
  } catch (error) {
    const msg = errorMessage(error);
    reportMcpCommandResult(state, 'reset', {
      requestId: command.requestId,
      success: false,
      error: msg,
    }, startTime);
  }
}

/**
 * @brief Handle MCP cancel command.
 *
 * The actual cancellation is performed inside the MCP server (which
 * keeps the authoritative `activeOperations` set).  The extension-side
 * handler just acknowledges the request so the server can complete.
 */
async function handleMcpCancelCommand(state: ExtensionState, command: { requestId: string; targetRequestId?: string }): Promise<void> {
  const startTime = Date.now();
  reportMcpCommandResult(state, 'cancel', {
    requestId: command.requestId,
    success: true,
  }, startTime, command.targetRequestId ? `target=${command.targetRequestId}` : 'current');
}

/**
 * @brief Handle MCP validate command.
 */
async function handleMcpValidateCommand(state: ExtensionState, command: { requestId: string; file?: string; code?: string }): Promise<void> {
  const startTime = Date.now();

  try {
    let rubyCode: string;

    if (command.code) {
      rubyCode = command.code;
    } else if (command.file) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      const sourceFile = command.file ?? state.currentSourceFile;
      const filePath = ws ? path.join(ws.uri.fsPath, sourceFile) : sourceFile;

      // Guard against path traversal (SEC-02): resolved path must be inside workspace
      if (ws) {
        const resolvedFile = path.resolve(filePath);
        const resolvedWsRoot = path.resolve(ws.uri.fsPath);
        const rel = path.relative(resolvedWsRoot, resolvedFile);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          throw new Error('Invalid file path: path traversal detected');
        }
      }
      if (!sourceFile.endsWith('.rb')) {
        throw new Error('Only .rb files are supported');
      }

      const fileUri = vscode.Uri.file(filePath);
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      rubyCode = new TextDecoder().decode(fileContent);
    } else {
      throw new Error('Either code or file must be provided');
    }

    // Compile
    const compileErrors: string[] = [];
    const result = compile(rubyCode, undefined, (err) => compileErrors.push(err));

    if (result.success) {
      reportMcpCommandResult(state, 'validate', {
        requestId: command.requestId,
        success: true,
      }, startTime, 'syntax OK');
    } else {
      reportMcpCommandResult(state, 'validate', {
        requestId: command.requestId,
        success: false,
        error: result.error ?? 'Syntax validation failed',
      }, startTime);
    }
  } catch (error) {
    const msg = errorMessage(error);
    reportMcpCommandResult(state, 'validate', {
      requestId: command.requestId,
      success: false,
      error: msg,
    }, startTime);
  }
}
