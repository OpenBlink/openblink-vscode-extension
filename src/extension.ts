/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { BleManager } from './ble-manager';
import { errorMessage } from './error-utils';
import { initCompiler } from './compiler';
import * as boardManager from './board-manager';
import * as ui from './ui-manager';
import * as mcpBridge from './mcp-bridge';
import { SavedDevice } from './types';
import { ExtensionState, SAVED_DEVICES_KEY } from './extension-state';
import { buildAndBlink } from './build-pipeline';
import { handleMcpBuildTrigger, handleMcpCommand } from './mcp-command-handlers';
import { installMcpToWorkspace, showMcpConfigSnippet } from './mcp-config-installer';
import { registerCommands } from './commands';

/**
 * @brief Control characters stripped from device console output (all except
 * printable ASCII and common whitespace) to prevent terminal/prompt injection
 * from malicious BLE devices.
 */
const CONSOLE_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;

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
  const state = new ExtensionState();
  // Initialize UI
  const outputChannel = ui.createOutputChannel();
  const diagnosticCollection = ui.createDiagnosticCollection();
  const statusBar = ui.createStatusBar();
  context.subscriptions.push(outputChannel, diagnosticCollection, statusBar);

  const extensionVersion = vscode.extensions.getExtension('OpenBlink.openblink-extension')?.packageJSON?.version ?? 'unknown';
  ui.log(`[SYSTEM] OpenBlink VSCode Extension v${extensionVersion} started.`);

  // Initialize settings
  state.currentSourceFile = vscode.workspace.getConfiguration('openblink').get<string>('sourceFile') ?? 'app.rb';
  state.currentSlot = vscode.workspace.getConfiguration('openblink').get<number>('slot') ?? 2;

  // Initialize TreeView providers (must be created before event listeners reference them)
  state.devicesProvider = new ui.DevicesTreeProvider();
  state.tasksProvider = new ui.TasksTreeProvider();
  state.deviceInfoProvider = new ui.DeviceInfoTreeProvider();
  state.metricsProvider = new ui.MetricsTreeProvider();
  state.boardReferenceProvider = new ui.BoardReferenceTreeProvider();
  state.mcpStatusProvider = new ui.McpStatusTreeProvider();

  // Initialize BLE manager
  state.bleManager = new BleManager();
  context.subscriptions.push({
    dispose: () => state.bleManager.dispose()
  });

  state.bleManager.onConnectionStateChanged((connectionState) => {
    const reconnect = connectionState === 'reconnecting' ? state.bleManager.reconnectInfo : undefined;
    ui.updateStatusBar(connectionState, state.bleManager.deviceName, undefined, state.currentSlot, reconnect);
    state.tasksProvider.update({ connected: state.bleManager.isConnected });
    state.deviceInfoProvider.update({
      connected: state.bleManager.isConnected,
      deviceName: state.bleManager.deviceName,
      deviceId: state.bleManager.deviceId,
      mtu: state.bleManager.negotiatedMTU,
    });
    state.devicesProvider.updateConnection(connectionState, state.bleManager.deviceId);

    // Update MCP bridge with connection state
    mcpBridge.updateConnectionStatus(
      connectionState,
      state.bleManager.deviceName,
      state.bleManager.deviceId,
      state.bleManager.negotiatedMTU,
    );

    // Auto-save device on successful connection
    if (connectionState === 'connected' && state.bleManager.deviceId) {
      const saved = context.globalState.get<SavedDevice[]>(SAVED_DEVICES_KEY, []);
      if (!saved.some(d => d.id === state.bleManager.deviceId)) {
        const updated = [...saved, { name: state.bleManager.deviceName, id: state.bleManager.deviceId }];
        void context.globalState.update(SAVED_DEVICES_KEY, updated);
        state.devicesProvider.setSavedDevices(updated);
      }
    }
  });

  state.bleManager.onScanningStateChanged((isScanning) => {
    state.devicesProvider.updateScanning(isScanning);
  });

  state.bleManager.onDeviceDiscovered((info) => {
    state.devicesProvider.addDiscoveredDevice(info);
  });

  state.bleManager.onConsoleOutput((message) => {
    const lines = message.includes('\n') ? message.split('\n') : [message];
    for (const line of lines) {
      const sanitized = line.replace(CONSOLE_CONTROL_CHARS, '');
      if (sanitized.length > 0) {
        const formatted = `[DEVICE] ${sanitized}`;
        ui.log(formatted);
        ui.appendConsoleLog(formatted);
      }
    }
    mcpBridge.scheduleConsoleWrite();
  });

  state.bleManager.onLog((message) => {
    ui.log(message);
  });

  // Restore saved devices from globalState
  const savedDevices = context.globalState.get<SavedDevice[]>(SAVED_DEVICES_KEY, []);
  state.devicesProvider.setSavedDevices(savedDevices);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('openblink-devices', state.devicesProvider),
    vscode.window.registerTreeDataProvider('openblink-tasks', state.tasksProvider),
    vscode.window.registerTreeDataProvider('openblink-device-info', state.deviceInfoProvider),
    vscode.window.registerTreeDataProvider('openblink-metrics', state.metricsProvider),
    vscode.window.registerTreeDataProvider('openblink-board-reference', state.boardReferenceProvider),
    vscode.window.registerTreeDataProvider('openblink-mcp-status', state.mcpStatusProvider),
    { dispose: () => state.devicesProvider.dispose() },
    { dispose: () => state.tasksProvider.dispose() },
    { dispose: () => state.deviceInfoProvider.dispose() },
    { dispose: () => state.metricsProvider.dispose() },
    { dispose: () => state.boardReferenceProvider.dispose() },
    { dispose: () => state.mcpStatusProvider.dispose() }
  );

  // Load boards
  const _boards = boardManager.loadBoards(context.extensionUri);
  const currentBoard = boardManager.getCurrentBoard();
  state.tasksProvider.update({
    sourceFile: state.currentSourceFile,
    boardName: currentBoard?.displayName ?? '',
    slot: state.currentSlot,
  });
  if (currentBoard) {
    state.boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(currentBoard));
  }

  // ========================================================================
  // MCP Bridge (file-based IPC for AI agent integration)
  // ========================================================================

  // Register MCP build trigger callback — invoked when the MCP server
  // writes a `trigger.json` file.
  // NOTE: Must be registered BEFORE initialize() so that any existing
  // trigger.json at startup is not consumed without being processed.
  mcpBridge.onBuildTrigger((filePath, requestId) => handleMcpBuildTrigger(state, filePath, requestId));
  mcpBridge.onCommand((command) => handleMcpCommand(state, command));

  mcpBridge.initialize(context);

  // Set initial MCP enabled state immediately after initialize() reads the
  // setting, before any debounced writes can fire.
  state.mcpStatusProvider.update({ mcpEnabled: mcpBridge.isEnabled() });

  // Set up MCP write callbacks to update the MCP status tree view
  mcpBridge.setWriteCallbacks({
    onStatusWritten: () => state.mcpStatusProvider.update({ lastStatusWriteTime: new Date() }),
    onConsoleWritten: () => state.mcpStatusProvider.update({ lastConsoleWriteTime: new Date() }),
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

    // Notify VS Code to re-query server definitions when the MCP integration
    // is toggled via `openblink.mcp.enabled`, so the server is started or
    // stopped without reloading the window.
    const mcpDefinitionsChanged = new vscode.EventEmitter<void>();
    context.subscriptions.push(mcpDefinitionsChanged);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('openblink.mcp.enabled')) {
          mcpDefinitionsChanged.fire();
        }
      }),
    );

    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('openblink.mcpServer', {
        onDidChangeMcpServerDefinitions: mcpDefinitionsChanged.event,
        provideMcpServerDefinitions: async () => {
          if (!mcpBridge.isEnabled()) { return []; }
          const ipcDir = mcpBridge.resolveIpcDir(context);
          if (!ipcDir) { return []; }
          return [
            new vscode.McpStdioServerDefinition(
              'OpenBlink',
              'node',
              [mcpServerModule],
              { OPENBLINK_IPC_DIR: ipcDir, OPENBLINK_EXTENSION_DIR: context.extensionUri.fsPath },
              extensionVersion,
            ),
          ];
        },
        resolveMcpServerDefinition: async (server: vscode.McpServerDefinition) => server,
      }),
    );
  }

  // Clear the MCP command history (triggered by the view title-bar button).
  context.subscriptions.push(
    vscode.commands.registerCommand('openblink.clearMcpHistory', () => {
      state.mcpStatusProvider.clearHistory();
      ui.log('[MCP] History cleared');
    }),
  );

  // Register setupMcp command — offers installation to .vscode/mcp.json (VS Code 1.106+)
  // or generation of a JSON snippet for Windsurf/Cursor/Cline.
  context.subscriptions.push(
    vscode.commands.registerCommand('openblink.setupMcp', async () => {
      const ipcDir = mcpBridge.resolveIpcDir(context);
      if (!ipcDir) {
        vscode.window.showErrorMessage(
          l10n.t('Cannot generate MCP configuration: no workspace is open. Please open a folder first.'),
        );
        return;
      }

      const workspaceChoice = {
        label: l10n.t('Install to workspace (.vscode/mcp.json)'),
        description: l10n.t('For VS Code Copilot (workspace-local)'),
        choice: 'workspace' as const,
      };
      const globalChoice = {
        label: l10n.t('Show JSON snippet'),
        description: l10n.t('For Windsurf Cascade / Cursor / Cline (copy to your IDE config)'),
        choice: 'snippet' as const,
      };
      const picked = await vscode.window.showQuickPick([workspaceChoice, globalChoice], {
        placeHolder: l10n.t('How would you like to set up the MCP server?'),
      });
      if (!picked) { return; }

      if (picked.choice === 'workspace') {
        await installMcpToWorkspace(context);
      } else {
        await showMcpConfigSnippet(context, ipcDir);
      }
    }),
  );

  // Register installMcpWorkspace command — directly writes to .vscode/mcp.json.
  context.subscriptions.push(
    vscode.commands.registerCommand('openblink.installMcpWorkspace', async () => {
      await installMcpToWorkspace(context);
    }),
  );

  registerCommands(context, state);

  // Initialize compiler
  initCompiler(context.extensionUri).then(() => {
    ui.log('[SYSTEM] mrbc WASM compiler initialized.');
  }).catch((error: unknown) => {
    const msg = errorMessage(error);
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
  // saves in state.pendingManualSave and check it in onDidSaveTextDocument.
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.reason === vscode.TextDocumentSaveReason.Manual) {
        const key = e.document.uri.toString();
        state.pendingManualSave.add(key);
        // Safety: remove stale entry if onDidSaveTextDocument never fires
        // (e.g. save fails due to a disk error).
        setTimeout(() => { state.pendingManualSave.delete(key); }, 5000);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const key = document.uri.toString();
      if (!state.pendingManualSave.delete(key)) { return; }
      if (!document.fileName.endsWith('.rb')) { return; }
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (!activeDoc || activeDoc.uri.toString() !== key) { return; }
      try {
        await buildAndBlink(state, document.uri, { silent: true });
      } catch (error) {
        const msg = errorMessage(error);
        ui.log(`[SYSTEM] Build error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    }),
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('openblink.sourceFile')) {
        state.currentSourceFile = vscode.workspace.getConfiguration('openblink').get<string>('sourceFile') ?? 'app.rb';
        state.tasksProvider.update({ sourceFile: state.currentSourceFile });
        mcpBridge.updateStatus({ sourceFile: state.currentSourceFile });
      }
      if (e.affectsConfiguration('openblink.slot')) {
        const raw = vscode.workspace.getConfiguration('openblink').get<number>('slot');
        state.currentSlot = (raw === 1 || raw === 2) ? raw : 2;
        state.tasksProvider.update({ slot: state.currentSlot });
        ui.updateStatusBar(state.bleManager.connectionState, state.bleManager.deviceName, undefined, state.currentSlot);
        mcpBridge.updateStatus({ slot: state.currentSlot });
      }
      if (e.affectsConfiguration('openblink.board')) {
        const boards = boardManager.getBoards();
        const boardName = vscode.workspace.getConfiguration('openblink').get<string>('board') ?? '';
        const found = boards.find(b => b.name === boardName);
        if (found) {
          boardManager.setCurrentBoard(found);
          state.tasksProvider.update({ boardName: found.displayName });
          state.boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(found));
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
        state.mcpStatusProvider.update({ mcpEnabled: newEnabled });
        ui.log(`[MCP] Integration ${newEnabled ? 'enabled' : 'disabled'}.`);
      }
    }),
  );

}

/**
 * @brief Extension deactivation hook.
 *
 * Flushes pending MCP IPC state (status, console, and queued writes) so
 * the MCP server sees the final snapshot, then lets the disposables
 * registered in {@link activate} handle the remaining cleanup.  The BLE
 * manager's {@link BleManager.dispose} performs a best-effort BLE
 * disconnect to avoid connection leaks.
 */
export async function deactivate(): Promise<void> {
  await mcpBridge.flushAll();
}
