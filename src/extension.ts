/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { BleManager } from './ble-manager';
import { initCompiler, compile, parseDiagnostics } from './compiler';
import { sendFirmware, sendReset } from './protocol';
import * as boardManager from './board-manager';
import * as ui from './ui-manager';
import * as mcpBridge from './mcp-bridge';
import { BLE_CONSTANTS, MetricsData, SavedDevice } from './types';

/** @brief globalState key for persisted saved-device list. */
const SAVED_DEVICES_KEY = 'openblink.savedDevices';

/** @brief Singleton BLE manager instance. */
let bleManager: BleManager;
/** @brief Sidebar tree-view provider for BLE device scanning and selection. */
let devicesProvider: ui.DevicesTreeProvider;
/** @brief Sidebar tree-view provider for user actions. */
let tasksProvider: ui.TasksTreeProvider;
/** @brief Sidebar tree-view provider for connected device information. */
let deviceInfoProvider: ui.DeviceInfoTreeProvider;
/** @brief Sidebar tree-view provider for build/transfer metrics. */
let metricsProvider: ui.MetricsTreeProvider;
/** @brief Sidebar tree-view provider for selected board's API reference. */
let boardReferenceProvider: ui.BoardReferenceTreeProvider;
/** @brief Sidebar tree-view provider for MCP integration status. */
let mcpStatusProvider: ui.McpStatusTreeProvider;
/** @brief Workspace-relative path of the Ruby source file to compile. */
let currentSourceFile: string;
/** @brief Active program slot on the target device (1 or 2). */
let currentSlot: number;
/** @brief Guard flag to prevent overlapping build-and-blink operations. */
let isBuilding = false;
/** @brief URIs of files being saved manually (not by auto-save). */
const pendingManualSave = new Set<string>();

/**
 * @brief Extension activation entry point.
 *
 * Called by VS Code when the extension is first activated. Initialises the
 * output channel, status bar, BLE manager, tree-view providers (including
 * the {@link DevicesTreeProvider} for BLE device scanning/selection),
 * board definitions, and the mruby WASM compiler.  Restores saved devices
 * from `globalState` and registers all user-facing commands, including
 * scan start/stop, device connection by ID, and device forget.
 *
 * Registers an `onDidSaveTextDocument` listener that automatically triggers
 * a build-and-blink cycle when the user saves a `.rb` file that is currently
 * focused in the active editor.  Background saves (e.g. `files.autoSave`,
 * format-on-save of non-focused files) are ignored to prevent unintended
 * BLE transfers.
 *
 * Also registers a `onDidChangeConfiguration` listener so that changes to
 * `openblink.sourceFile`, `openblink.slot`, and `openblink.board` made
 * via the Settings UI are reflected immediately without reloading.
 *
 * The extension version is read dynamically from `package.json` via
 * `vscode.extensions.getExtension()` to avoid hard-coded version drift.
 *
 * @param context  Extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
  // Initialize UI
  const outputChannel = ui.createOutputChannel();
  const diagnosticCollection = ui.createDiagnosticCollection();
  const statusBar = ui.createStatusBar();
  context.subscriptions.push(outputChannel, diagnosticCollection, statusBar);

  const extensionVersion = vscode.extensions.getExtension('OpenBlink.openblink-vscode-extension')?.packageJSON?.version ?? 'unknown';
  ui.log(`[SYSTEM] OpenBlink VSCode Extension v${extensionVersion} started.`);

  // Initialize settings
  currentSourceFile = vscode.workspace.getConfiguration('openblink').get<string>('sourceFile') ?? 'app.rb';
  currentSlot = vscode.workspace.getConfiguration('openblink').get<number>('slot') ?? 2;

  // Initialize TreeView providers (must be created before event listeners reference them)
  devicesProvider = new ui.DevicesTreeProvider();
  tasksProvider = new ui.TasksTreeProvider();
  deviceInfoProvider = new ui.DeviceInfoTreeProvider();
  metricsProvider = new ui.MetricsTreeProvider();
  boardReferenceProvider = new ui.BoardReferenceTreeProvider();
  mcpStatusProvider = new ui.McpStatusTreeProvider();

  // Initialize BLE manager
  bleManager = new BleManager();
  context.subscriptions.push({
    dispose: () => bleManager.dispose()
  });

  bleManager.onConnectionStateChanged((state) => {
    const reconnect = state === 'reconnecting' ? bleManager.reconnectInfo : undefined;
    ui.updateStatusBar(state, bleManager.deviceName, undefined, currentSlot, reconnect);
    tasksProvider.update({ connected: bleManager.isConnected });
    deviceInfoProvider.update({
      connected: bleManager.isConnected,
      deviceName: bleManager.deviceName,
      deviceId: bleManager.deviceId,
      mtu: bleManager.negotiatedMTU,
    });
    devicesProvider.updateConnection(state, bleManager.deviceId);

    // Update MCP bridge with connection state
    mcpBridge.updateConnectionStatus(
      state,
      bleManager.deviceName,
      bleManager.deviceId,
      bleManager.negotiatedMTU,
    );

    // Auto-save device on successful connection
    if (state === 'connected' && bleManager.deviceId) {
      const saved = context.globalState.get<SavedDevice[]>(SAVED_DEVICES_KEY, []);
      if (!saved.some(d => d.id === bleManager.deviceId)) {
        const updated = [...saved, { name: bleManager.deviceName, id: bleManager.deviceId }];
        void context.globalState.update(SAVED_DEVICES_KEY, updated);
        devicesProvider.setSavedDevices(updated);
      }
    }
  });

  bleManager.onScanningStateChanged((isScanning) => {
    devicesProvider.updateScanning(isScanning);
  });

  bleManager.onDeviceDiscovered((info) => {
    devicesProvider.addDiscoveredDevice(info);
  });

  bleManager.onConsoleOutput((message) => {
    for (const line of message.split('\n')) {
      // Strip carriage returns and control characters (except printable ASCII
      // and common whitespace) to prevent terminal/prompt injection from
      // malicious BLE devices.
      const sanitized = line.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
      if (sanitized.length > 0) {
        ui.log(`[DEVICE] ${sanitized}`);
        ui.appendConsoleLog(`[DEVICE] ${sanitized}`);
      }
    }
    mcpBridge.scheduleConsoleWrite();
  });

  bleManager.onLog((message) => {
    ui.log(message);
  });

  // Restore saved devices from globalState
  const savedDevices = context.globalState.get<SavedDevice[]>(SAVED_DEVICES_KEY, []);
  devicesProvider.setSavedDevices(savedDevices);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('openblink-devices', devicesProvider),
    vscode.window.registerTreeDataProvider('openblink-tasks', tasksProvider),
    vscode.window.registerTreeDataProvider('openblink-device-info', deviceInfoProvider),
    vscode.window.registerTreeDataProvider('openblink-metrics', metricsProvider),
    vscode.window.registerTreeDataProvider('openblink-board-reference', boardReferenceProvider),
    vscode.window.registerTreeDataProvider('openblink-mcp-status', mcpStatusProvider),
    { dispose: () => devicesProvider.dispose() },
    { dispose: () => tasksProvider.dispose() },
    { dispose: () => deviceInfoProvider.dispose() },
    { dispose: () => metricsProvider.dispose() },
    { dispose: () => boardReferenceProvider.dispose() },
    { dispose: () => mcpStatusProvider.dispose() }
  );

  // Load boards
  const _boards = boardManager.loadBoards(context.extensionUri);
  const currentBoard = boardManager.getCurrentBoard();
  tasksProvider.update({
    sourceFile: currentSourceFile,
    boardName: currentBoard?.displayName ?? '',
    slot: currentSlot,
  });
  if (currentBoard) {
    boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(currentBoard));
  }

  // ========================================================================
  // MCP Bridge (file-based IPC for AI agent integration)
  // ========================================================================

  // Register MCP build trigger callback — invoked when the MCP server
  // (or a Cascade Hook) writes a `trigger.json` file.
  // NOTE: Must be registered BEFORE initialize() so that any existing
  // trigger.json at startup is not consumed without being processed.
  mcpBridge.onBuildTrigger(async (filePath: string, requestId: string) => {
    ui.log(`[MCP] Build trigger received: ${filePath} (${requestId})`);
    mcpStatusProvider.update({ lastTriggerTime: new Date(), lastTriggerRequestId: requestId });
    try {
      const sourceUri = vscode.Uri.file(filePath);
      const buildResult = await buildAndBlink(context, sourceUri, { silent: true });

      // Write build result for MCP server to consume
      const history = ui.getMetricsHistory();
      const lastCompile = history.compile.length > 0 ? history.compile[history.compile.length - 1] : undefined;
      const lastTransfer = history.transfer.length > 0 ? history.transfer[history.transfer.length - 1] : undefined;
      const lastSize = history.size.length > 0 ? history.size[history.size.length - 1] : undefined;

      mcpBridge.writeBuildResult({
        requestId,
        success: buildResult.success,
        compileTime: buildResult.success ? lastCompile : undefined,
        transferTime: buildResult.success ? lastTransfer : undefined,
        programSize: buildResult.success ? lastSize : undefined,
        error: buildResult.error,
      });
      mcpStatusProvider.update({
        lastResultTime: new Date(),
        lastResultSuccess: buildResult.success,
        lastResultError: buildResult.error,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      mcpBridge.writeBuildResult({ requestId, success: false, error: msg });
      mcpStatusProvider.update({ lastResultTime: new Date(), lastResultSuccess: false, lastResultError: msg });
    }
  });

  mcpBridge.initialize(context);

  // Set initial MCP enabled state immediately after initialize() reads the
  // setting, before any debounced writes can fire.
  mcpStatusProvider.update({ mcpEnabled: mcpBridge.isEnabled() });

  // Set up MCP write callbacks to update the MCP status tree view
  mcpBridge.setWriteCallbacks({
    onStatusWritten: () => mcpStatusProvider.update({ lastStatusWriteTime: new Date() }),
    onConsoleWritten: () => mcpStatusProvider.update({ lastConsoleWriteTime: new Date() }),
  });

  // Set initial board status for MCP
  if (currentBoard) {
    mcpBridge.updateBoardStatus({
      name: currentBoard.name,
      displayName: currentBoard.displayName,
      referencePath: boardManager.getLocalizedReferencePath(currentBoard),
    });
  }

  // Register MCP Server Definition Provider for VS Code Copilot auto-discovery.
  // This allows Copilot Agent Mode to discover and use the OpenBlink MCP server
  // without any manual configuration in mcp.json.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
    const mcpServerModule = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('openblink.mcpServer', {
        provideMcpServerDefinitions: async () => {
          if (!mcpBridge.isEnabled()) { return []; }
          return [
            new vscode.McpStdioServerDefinition(
              'OpenBlink',
              'node',
              [mcpServerModule],
              { OPENBLINK_WORKSPACE: workspaceRoot, OPENBLINK_EXTENSION_DIR: context.extensionUri.fsPath },
              extensionVersion,
            ),
          ];
        },
        resolveMcpServerDefinition: async (server: vscode.McpServerDefinition) => server,
      }),
    );
  }

  // Register setupMcp command — generates MCP configuration for Windsurf/Cursor/Cline
  context.subscriptions.push(
    vscode.commands.registerCommand('openblink.setupMcp', async () => {
      const mcpServerPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const configSnippet = JSON.stringify({
        mcpServers: {
          openblink: {
            command: 'node',
            args: [mcpServerPath],
            env: { OPENBLINK_WORKSPACE: workspaceRoot, OPENBLINK_EXTENSION_DIR: context.extensionUri.fsPath },
          },
        },
      }, null, 2);

      const doc = await vscode.workspace.openTextDocument({
        content: configSnippet,
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        l10n.t('Copy this MCP server configuration to your IDE\'s MCP config file.'),
      );
    }),
  );

  // Initialize compiler
  initCompiler(context.extensionUri).then(() => {
    ui.log('[SYSTEM] mrbc WASM compiler initialized.');
  }).catch((error: Error) => {
    const msg = error.message ?? String(error);
    ui.log(`[SYSTEM] Compiler initialization failed: ${msg}`);
    vscode.window.showErrorMessage(l10n.t('Compiler initialization failed: {0}', msg));
  });

  // Auto build-and-blink when the user manually saves a .rb file that is
  // currently focused in the editor.  Ignores background saves (e.g.
  // files.autoSave, format-on-save of non-focused files) to avoid
  // unintended BLE transfers.
  //
  // onWillSaveTextDocument fires *before* the save and exposes the
  // save reason (Manual vs AfterDelay/FocusOut).  We record manual
  // saves in pendingManualSave and check it in onDidSaveTextDocument.
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.reason === vscode.TextDocumentSaveReason.Manual) {
        const key = e.document.uri.toString();
        pendingManualSave.add(key);
        // Safety: remove stale entry if onDidSaveTextDocument never fires
        // (e.g. save fails due to a disk error).
        setTimeout(() => { pendingManualSave.delete(key); }, 5000);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const key = document.uri.toString();
      if (!pendingManualSave.delete(key)) { return; }
      if (!document.fileName.endsWith('.rb')) { return; }
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (!activeDoc || activeDoc.uri.toString() !== key) { return; }
      try {
        await buildAndBlink(context, document.uri, { silent: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ui.log(`[SYSTEM] Build error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    }),
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openblink.sourceFile')) {
        currentSourceFile = vscode.workspace.getConfiguration('openblink').get<string>('sourceFile') ?? 'app.rb';
        tasksProvider.update({ sourceFile: currentSourceFile });
        mcpBridge.updateStatus({ sourceFile: currentSourceFile });
      }
      if (e.affectsConfiguration('openblink.slot')) {
        const raw = vscode.workspace.getConfiguration('openblink').get<number>('slot');
        currentSlot = (raw === 1 || raw === 2) ? raw : 2;
        tasksProvider.update({ slot: currentSlot });
        ui.updateStatusBar(bleManager.connectionState, bleManager.deviceName, undefined, currentSlot);
        mcpBridge.updateStatus({ slot: currentSlot });
      }
      if (e.affectsConfiguration('openblink.board')) {
        const boards = boardManager.getBoards();
        const boardName = vscode.workspace.getConfiguration('openblink').get<string>('board') ?? '';
        const found = boards.find(b => b.name === boardName);
        if (found) {
          boardManager.setCurrentBoard(found);
          tasksProvider.update({ boardName: found.displayName });
          boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(found));
          mcpBridge.updateBoardStatus({
            name: found.name,
            displayName: found.displayName,
            referencePath: boardManager.getLocalizedReferencePath(found),
          });
        }
      }
      // Dynamic MCP enable/disable
      if (e.affectsConfiguration('openblink.mcp.enabled')) {
        const newEnabled = vscode.workspace.getConfiguration('openblink').get<boolean>('mcp.enabled', true);
        mcpBridge.setEnabled(newEnabled);
        mcpStatusProvider.update({ mcpEnabled: newEnabled });
        ui.log(`[MCP] Integration ${newEnabled ? 'enabled' : 'disabled'}.`);
      }
    }),
  );

  // ========================================================================
  // Commands
  // ========================================================================

  context.subscriptions.push(
    // Legacy command kept for backward-compatibility; now starts a scan
    // instead of showing a QuickPick.
    vscode.commands.registerCommand('openblink.connectDevice', async () => {
      try {
        await bleManager.startScan();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Start scanning for OpenBlink devices (Devices view title-bar button).
    vscode.commands.registerCommand('openblink.scanDevices', async () => {
      try {
        await bleManager.startScan();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Stop an active BLE scan (Devices view title-bar button).
    vscode.commands.registerCommand('openblink.stopScan', async () => {
      await bleManager.stopScan();
    }),

    // Connect to a device that was found during the current scan.
    vscode.commands.registerCommand('openblink.connectScannedDevice', async (deviceId: unknown) => {
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        vscode.window.showErrorMessage(l10n.t('Invalid device ID'));
        return;
      }
      try {
        devicesProvider.updateConnection('connecting', deviceId);
        await bleManager.connectById(deviceId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Connect to a previously saved device.  If the device is not in the
    // current discovered list, a scan is triggered first and we wait for
    // the device to appear (or the scan to complete).
    vscode.commands.registerCommand('openblink.connectSavedDevice', async (deviceId: unknown) => {
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        vscode.window.showErrorMessage(l10n.t('Invalid device ID'));
        return;
      }
      if (!bleManager.discoveredDevices.has(deviceId)) {
        try {
          ui.log(`[BLE] ${l10n.t('Scanning to find saved device...')}`);
          await bleManager.startScan();
          // Wait for the device to appear or the scan to end, with an explicit timeout
          // to prevent the interval from leaking if scanning never completes.
          await new Promise<void>((resolve) => {
            const timeoutMs = BLE_CONSTANTS.SCAN_TIMEOUT + BLE_CONSTANTS.SCAN_GRACE_PERIOD;
            const deadline = setTimeout(() => {
              clearInterval(checkInterval);
              resolve();
            }, timeoutMs);
            const checkInterval = setInterval(() => {
              if (bleManager.discoveredDevices.has(deviceId) || !bleManager.isScanning) {
                clearInterval(checkInterval);
                clearTimeout(deadline);
                resolve();
              }
            }, BLE_CONSTANTS.DISCOVERY_POLL_INTERVAL);
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(msg);
          return;
        }
      }
      try {
        devicesProvider.updateConnection('connecting', deviceId);
        await bleManager.connectById(deviceId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Remove a saved device from globalState (context-menu trash icon).
    vscode.commands.registerCommand('openblink.forgetDevice', async (item: { deviceId?: string }) => {
      const deviceId = item?.deviceId;
      if (!deviceId) { return; }
      const saved = context.globalState.get<SavedDevice[]>(SAVED_DEVICES_KEY, []);
      const updated = saved.filter(d => d.id !== deviceId);
      await context.globalState.update(SAVED_DEVICES_KEY, updated);
      devicesProvider.setSavedDevices(updated);
    }),

    vscode.commands.registerCommand('openblink.disconnectDevice', async () => {
      await bleManager.disconnect();
    }),

    vscode.commands.registerCommand('openblink.buildAndBlink', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.rb')) {
          await buildAndBlink(context, editor.document.uri);
        } else {
          // Fallback to configured source file
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders) {
            await buildAndBlink(context, vscode.Uri.joinPath(workspaceFolders[0].uri, currentSourceFile));
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ui.log(`[SYSTEM] Build error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('openblink.softReset', async () => {
      const programChar = bleManager.getProgramCharacteristic();
      if (!bleManager.isConnected || !programChar) {
        vscode.window.showErrorMessage(l10n.t('Device is not connected'));
        return;
      }
      try {
        await sendReset(programChar, (msg) => ui.log(msg));
        vscode.window.showInformationMessage(l10n.t('Soft reset executed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('openblink.selectSourceFile', async (fileUri?: vscode.Uri) => {
      if (fileUri?.fsPath) {
        currentSourceFile = vscode.workspace.asRelativePath(fileUri, false);
      } else {
        const rubyFiles = await vscode.workspace.findFiles('**/*.rb');
        if (rubyFiles.length === 0) {
          vscode.window.showErrorMessage(l10n.t('No Ruby files found in the workspace'));
          return;
        }
        const items = rubyFiles.map(f => ({
          label: vscode.workspace.asRelativePath(f, false),
          uri: f,
        }));
        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: l10n.t('Select a Ruby file to compile'),
        });
        if (!selected) { return; }
        currentSourceFile = selected.label;
      }

      await vscode.workspace.getConfiguration('openblink').update('sourceFile', currentSourceFile, vscode.ConfigurationTarget.Workspace);
      tasksProvider.update({ sourceFile: currentSourceFile });
      vscode.window.showInformationMessage(l10n.t('Source file set to: {0}', currentSourceFile));
      ui.log(`[SYSTEM] ${l10n.t('Source file set to: {0}', currentSourceFile)}`);
    }),

    vscode.commands.registerCommand('openblink.selectBoard', async () => {
      const board = await boardManager.selectBoard();
      if (board) {
        tasksProvider.update({ boardName: board.displayName });
        boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(board));
        vscode.window.showInformationMessage(l10n.t('Board set to: {0}', board.displayName));
        ui.log(`[SYSTEM] ${l10n.t('Board set to: {0}', board.displayName)}`);
      }
    }),

    vscode.commands.registerCommand('openblink.selectSlot', async () => {
      const items = [
        { label: 'Slot 1', slot: 1 },
        { label: 'Slot 2', slot: 2 },
      ];
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: l10n.t('Select a slot'),
      });
      if (selected) {
        currentSlot = selected.slot;
        await vscode.workspace.getConfiguration('openblink').update('slot', currentSlot, vscode.ConfigurationTarget.Global);
        tasksProvider.update({ slot: currentSlot });
        ui.updateStatusBar(bleManager.connectionState, bleManager.deviceName, undefined, currentSlot);
        vscode.window.showInformationMessage(l10n.t('Slot set to: {0}', String(currentSlot)));
        ui.log(`[SYSTEM] ${l10n.t('Slot set to: {0}', String(currentSlot))}`);
      }
    }),
  );
}

/**
 * @brief Compile the given Ruby source file and transfer the bytecode over BLE.
 *
 * Acts as a concurrency guard around {@link buildAndBlinkInner}.  If a build
 * is already in progress, the call is silently skipped to prevent overlapping
 * BLE transfers that could corrupt the protocol stream.
 *
 * @param context    Extension context (unused here but kept for API symmetry).
 * @param sourceUri  URI of the Ruby source file to compile.
 * @param options    Optional settings.  When `silent` is true, the concurrency
 *                   skip does not show a user-facing warning (used for
 *                   auto-triggered builds from the save listener).
 */
async function buildAndBlink(context: vscode.ExtensionContext, sourceUri: vscode.Uri, options?: { silent?: boolean }): Promise<{ success: boolean; error?: string }> {
  if (isBuilding) {
    ui.log('[SYSTEM] Build already in progress, skipping.');
    if (!options?.silent) {
      vscode.window.showWarningMessage(l10n.t('Build already in progress'));
    }
    return { success: false, error: 'Build already in progress' };
  }
  isBuilding = true;
  try {
    return await buildAndBlinkInner(context, sourceUri);
  } finally {
    isBuilding = false;
  }
}

/**
 * @brief Inner implementation of build-and-blink.
 *
 * Reads the source file, compiles it with mrbc, and (if a device is
 * connected) sends the resulting bytecode to the selected program slot.
 * Updates diagnostics, metrics, and the status bar accordingly.
 *
 * @param context    Extension context (unused here but kept for API symmetry).
 * @param sourceUri  URI of the Ruby source file to compile.
 */
async function buildAndBlinkInner(context: vscode.ExtensionContext, sourceUri: vscode.Uri): Promise<{ success: boolean; error?: string }> {
  try {
    await vscode.workspace.fs.stat(sourceUri);
  } catch {
    const errorMsg = l10n.t('Source file not found: {0}', sourceUri.fsPath);
    vscode.window.showErrorMessage(errorMsg);
    mcpBridge.updateBuildResult(false, errorMsg);
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
    if (compileErrors.length > 0) {
      const diagnostics = parseDiagnostics(compileErrors.join('\n'), sourceUri);
      ui.setDiagnostics(sourceUri, diagnostics);
    }
    vscode.window.showErrorMessage(l10n.t('Compilation failed'));
    mcpBridge.updateBuildResult(false, result.error ?? 'Compilation failed');
    return { success: false, error: result.error ?? 'Compilation failed' };
  }

  ui.log(`[COMPILE] success: ${result.compileTime.toFixed(1)}ms, size: ${result.size} bytes`);

  // Transfer via BLE
  const programChar = bleManager.getProgramCharacteristic();
  if (!bleManager.isConnected || !programChar || !result.bytecode) {
    vscode.window.showWarningMessage(l10n.t('Device is not connected'));

    const metrics: MetricsData = { compileTime: result.compileTime, programSize: result.size };
    ui.recordMetrics(metrics);
    metricsProvider.updateMetrics(metrics);
    ui.updateStatusBar(bleManager.connectionState, bleManager.deviceName, metrics, currentSlot);
    const history = ui.getMetricsHistory();
    mcpBridge.updateMetricsStatus(metrics, {
      compile: ui.calculateStats(history.compile),
      transfer: ui.calculateStats(history.transfer),
      size: ui.calculateStats(history.size),
    });
    mcpBridge.updateBuildResult(false, 'Device is not connected');
    return { success: false, error: 'Compiled successfully but device is not connected' };
  }

  const transferStart = performance.now();
  try {
    await sendFirmware(programChar, result.bytecode, currentSlot, bleManager.negotiatedMTU, (msg) => ui.log(msg));
    const transferTime = performance.now() - transferStart;

    const metrics: MetricsData = {
      compileTime: result.compileTime,
      transferTime,
      programSize: result.size,
    };
    ui.recordMetrics(metrics);
    metricsProvider.updateMetrics(metrics);
    ui.updateStatusBar('connected', bleManager.deviceName, metrics, currentSlot);
    const history = ui.getMetricsHistory();
    mcpBridge.updateMetricsStatus(metrics, {
      compile: ui.calculateStats(history.compile),
      transfer: ui.calculateStats(history.transfer),
      size: ui.calculateStats(history.size),
    });
    mcpBridge.updateBuildResult(true);

    ui.log(`[COMPILE] ${l10n.t('Compilation successful: {0}ms, size: {1} bytes', result.compileTime.toFixed(1), String(result.size))}`);
    ui.log(`[TRANSFER] ${l10n.t('Transfer complete: {0}ms', transferTime.toFixed(1))}`);
    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ui.log(`[TRANSFER] Error: ${msg}`);
    vscode.window.showErrorMessage(msg);
    mcpBridge.updateBuildResult(false, msg);
    return { success: false, error: msg };
  }
}

/**
 * @brief Extension deactivation hook.
 *
 * Currently a no-op; cleanup is handled by the disposables registered
 * in {@link activate}.  The BLE manager's {@link BleManager.dispose}
 * performs a best-effort BLE disconnect to avoid connection leaks.
 */
export function deactivate() {}
