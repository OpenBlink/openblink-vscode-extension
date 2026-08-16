/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { compile, parseDiagnostics } from './compiler';
import { sendFirmware } from './protocol';
import * as ui from './ui-manager';
import * as mcpBridge from './mcp-bridge';
import { MetricsData } from './types';
import { ExtensionState } from './extension-state';
import { errorMessage } from './error-utils';

/** @brief Outcome of a build-and-blink cycle. */
export interface BuildResult { success: boolean; error?: string; diagnostics?: string[]; }

export async function buildAndBlink(state: ExtensionState, sourceUri: vscode.Uri, options?: { silent?: boolean; requestId?: string }): Promise<BuildResult> {
  if (state.isBuilding) {
    ui.log('[SYSTEM] Build already in progress, skipping.');
    if (!options?.silent) {
      vscode.window.showWarningMessage(l10n.t('Build already in progress'));
    }
    return { success: false, error: 'Build already in progress' };
  }
  state.isBuilding = true;
  try {
    return await buildAndBlinkInner(state, sourceUri, options);
  } finally {
    state.isBuilding = false;
  }
}

/**
 * @brief Inner implementation of build-and-blink.
 *
 * Reads the source file, compiles it with mrbc, and (if a device is
 * connected) sends the resulting bytecode to the selected program slot.
 * Updates diagnostics, metrics, and the status bar accordingly.
 * Writes build diagnostics for MCP integration.
 *
 * @param state      Shared extension state.
 * @param sourceUri  URI of the Ruby source file to compile.
 * @param options    Optional settings including requestId for MCP tracking.
 */
async function buildAndBlinkInner(
  state: ExtensionState,
  sourceUri: vscode.Uri,
  _options?: { requestId?: string }
): Promise<{ success: boolean; error?: string; diagnostics?: string[] }> {
  const filePath = sourceUri.fsPath;
  const errors: Array<{ line: number; column: number; message: string; severity: 'error' | 'warning'; code?: string }> = [];

  try {
    await vscode.workspace.fs.stat(sourceUri);
  } catch {
    const errorMsg = l10n.t('Source file not found: {0}', filePath);
    vscode.window.showErrorMessage(errorMsg);
    mcpBridge.updateBuildResult(false, errorMsg);

    // Write diagnostics for MCP
    mcpBridge.writeBuildDiagnostics({
      timestamp: new Date().toISOString(),
      file: filePath,
      success: false,
      errors: [{ line: 0, column: 0, message: errorMsg, severity: 'error', code: 'FILE_NOT_FOUND' }],
      suggestions: ['Ensure the file exists in the workspace', 'Check the file path configuration'],
    });

    return { success: false, error: errorMsg };
  }

  // Read source
  const fileContent = await vscode.workspace.fs.readFile(sourceUri);
  const rubyCode = new TextDecoder().decode(fileContent);

  // Compile
  ui.clearDiagnostics(sourceUri);
  const compileErrors: string[] = [];
  const result = compile(rubyCode, undefined, (err) => compileErrors.push(err));

  if (!result.success) {
    ui.log(`[COMPILE] error: ${result.error}`);

    // Parse compile errors for diagnostics
    const parsedDiagnostics = compileErrors.length > 0
      ? parseDiagnostics(compileErrors.join('\n'), sourceUri)
      : [];

    if (parsedDiagnostics.length > 0) {
      ui.setDiagnostics(sourceUri, parsedDiagnostics);
      for (const d of parsedDiagnostics) {
        errors.push({
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          message: d.message,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        });
      }
    } else if (result.error) {
      errors.push({ line: 0, column: 0, message: result.error, severity: 'error' });
    }

    vscode.window.showErrorMessage(l10n.t('Compilation failed'));
    mcpBridge.updateBuildResult(false, result.error ?? 'Compilation failed');

    // Write diagnostics for MCP
    mcpBridge.writeBuildDiagnostics({
      timestamp: new Date().toISOString(),
      file: filePath,
      success: false,
      errors,
      suggestions: ['Check Ruby syntax', 'Review the board API reference for available methods'],
    });

    return { success: false, error: result.error ?? 'Compilation failed', diagnostics: compileErrors };
  }

  ui.log(`[COMPILE] success: ${result.compileTime.toFixed(1)}ms, size: ${result.size} bytes`);

  // Transfer via BLE
  const programChar = state.bleManager.getProgramCharacteristic();
  if (!state.bleManager.isConnected || !programChar || !result.bytecode) {
    vscode.window.showWarningMessage(l10n.t('Device is not connected'));

    const metrics: MetricsData = { compileTime: result.compileTime, programSize: result.size };
    ui.recordMetrics(metrics);
    state.metricsProvider.updateMetrics(metrics);
    ui.updateStatusBar(state.bleManager.connectionState, state.bleManager.deviceName, metrics, state.currentSlot);
    const history = ui.getMetricsHistory();
    mcpBridge.updateMetricsStatus(metrics, {
      compile: ui.calculateStats(history.compile),
      transfer: ui.calculateStats(history.transfer),
      size: ui.calculateStats(history.size),
    });
    mcpBridge.updateBuildResult(false, 'Device is not connected');

    // Write success diagnostics (compilation succeeded, transfer skipped)
    mcpBridge.writeBuildDiagnostics({
      timestamp: new Date().toISOString(),
      file: filePath,
      success: true,
      errors: [],
      suggestions: ['Connect to a device using connect_device to transfer the bytecode'],
    });

    return { success: false, error: 'Compiled successfully but device is not connected' };
  }

  const transferStart = performance.now();
  state.bleManager.isTransferring = true;
  try {
    await sendFirmware(programChar, result.bytecode, state.currentSlot, state.bleManager.negotiatedMTU, (msg) => ui.log(msg));
    const transferTime = performance.now() - transferStart;

    const metrics: MetricsData = {
      compileTime: result.compileTime,
      transferTime,
      programSize: result.size,
    };
    ui.recordMetrics(metrics);
    state.metricsProvider.updateMetrics(metrics);
    ui.updateStatusBar('connected', state.bleManager.deviceName, metrics, state.currentSlot);
    const history = ui.getMetricsHistory();
    mcpBridge.updateMetricsStatus(metrics, {
      compile: ui.calculateStats(history.compile),
      transfer: ui.calculateStats(history.transfer),
      size: ui.calculateStats(history.size),
    });
    mcpBridge.updateBuildResult(true);

    // Write success diagnostics
    mcpBridge.writeBuildDiagnostics({
      timestamp: new Date().toISOString(),
      file: filePath,
      success: true,
      errors: [],
      suggestions: ['Use get_console_output to check device output'],
    });

    ui.log(`[COMPILE] ${l10n.t('Compilation successful: {0}ms, size: {1} bytes', result.compileTime.toFixed(1), String(result.size))}`);
    ui.log(`[TRANSFER] ${l10n.t('Transfer complete: {0}ms', transferTime.toFixed(1))}`);
    return { success: true };
  } catch (error) {
    const msg = errorMessage(error);
    ui.log(`[TRANSFER] Error: ${msg}`);
    vscode.window.showErrorMessage(msg);
    mcpBridge.updateBuildResult(false, msg);

    // Write failure diagnostics
    mcpBridge.writeBuildDiagnostics({
      timestamp: new Date().toISOString(),
      file: filePath,
      success: false,
      errors: [{ line: 0, column: 0, message: msg, severity: 'error', code: 'TRANSFER_FAILED' }],
      suggestions: ['Check device connection', 'Try reconnecting to the device', 'Check MTU settings'],
    });

    return { success: false, error: msg };
  } finally {
    state.bleManager.isTransferring = false;
  }
}
