/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { sendReset } from './protocol';
import * as boardManager from './board-manager';
import * as ui from './ui-manager';
import { BLE_CONSTANTS, SavedDevice } from './types';
import { ExtensionState, SAVED_DEVICES_KEY } from './extension-state';
import { buildAndBlink } from './build-pipeline';
import { errorMessage } from './error-utils';

export function registerCommands(context: vscode.ExtensionContext, state: ExtensionState): void {
  context.subscriptions.push(
    // Legacy command kept for backward-compatibility; now starts a scan
    // instead of showing a QuickPick.
    vscode.commands.registerCommand('openblink.connectDevice', async () => {
      ui.showOutputChannelOnce();
      try {
        await state.bleManager.startScan();
      } catch (error) {
        const msg = errorMessage(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Start scanning for OpenBlink devices (Devices view title-bar button).
    vscode.commands.registerCommand('openblink.scanDevices', async () => {
      ui.showOutputChannelOnce();
      try {
        await state.bleManager.startScan();
      } catch (error) {
        const msg = errorMessage(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    // Stop an active BLE scan (Devices view title-bar button).
    vscode.commands.registerCommand('openblink.stopScan', async () => {
      await state.bleManager.stopScan();
    }),

    // Connect to a device that was found during the current scan.
    vscode.commands.registerCommand('openblink.connectScannedDevice', async (deviceId: unknown) => {
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        vscode.window.showErrorMessage(l10n.t('Invalid device ID'));
        return;
      }
      try {
        state.devicesProvider.updateConnection('connecting', deviceId);
        await state.bleManager.connectById(deviceId);
      } catch (error) {
        const msg = errorMessage(error);
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
      if (!state.bleManager.discoveredDevices.has(deviceId)) {
        try {
          ui.log(`[BLE] ${l10n.t('Scanning to find saved device...')}`);
          await state.bleManager.startScan();
          // Wait for the device to appear or the scan to end, with an explicit
          // timeout as an upper bound in case scanning never completes.
          await state.bleManager.waitForScanCompletion({
            deviceId,
            timeoutMs: BLE_CONSTANTS.SCAN_TIMEOUT + BLE_CONSTANTS.SCAN_GRACE_PERIOD,
          });
        } catch (error) {
          const msg = errorMessage(error);
          vscode.window.showErrorMessage(msg);
          return;
        }
      }
      try {
        state.devicesProvider.updateConnection('connecting', deviceId);
        await state.bleManager.connectById(deviceId);
      } catch (error) {
        const msg = errorMessage(error);
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
      state.devicesProvider.setSavedDevices(updated);
    }),

    vscode.commands.registerCommand('openblink.disconnectDevice', async () => {
      await state.bleManager.disconnect();
    }),

    vscode.commands.registerCommand('openblink.buildAndBlink', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.rb')) {
          await buildAndBlink(state, editor.document.uri);
        } else {
          // Fallback to configured source file
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders) {
            await buildAndBlink(state, vscode.Uri.joinPath(workspaceFolders[0].uri, state.currentSourceFile));
          }
        }
      } catch (error) {
        const msg = errorMessage(error);
        ui.log(`[SYSTEM] Build error: ${msg}`);
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('openblink.softReset', async () => {
      const programChar = state.bleManager.getProgramCharacteristic();
      if (!state.bleManager.isConnected || !programChar) {
        vscode.window.showErrorMessage(l10n.t('Device is not connected'));
        return;
      }
      try {
        await sendReset(programChar, (msg) => ui.log(msg));
        vscode.window.showInformationMessage(l10n.t('Soft reset executed'));
      } catch (error) {
        const msg = errorMessage(error);
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('openblink.selectSourceFile', async (fileUri?: vscode.Uri) => {
      if (fileUri?.fsPath) {
        state.currentSourceFile = vscode.workspace.asRelativePath(fileUri, false);
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
        state.currentSourceFile = selected.label;
      }

      await vscode.workspace.getConfiguration('openblink').update('sourceFile', state.currentSourceFile, vscode.ConfigurationTarget.Workspace);
      state.tasksProvider.update({ sourceFile: state.currentSourceFile });
      vscode.window.showInformationMessage(l10n.t('Source file set to: {0}', state.currentSourceFile));
      ui.log(`[SYSTEM] ${l10n.t('Source file set to: {0}', state.currentSourceFile)}`);
    }),

    vscode.commands.registerCommand('openblink.selectBoard', async () => {
      const board = await boardManager.selectBoard();
      if (board) {
        state.tasksProvider.update({ boardName: board.displayName });
        state.boardReferenceProvider.updateReference(boardManager.getLocalizedReferencePath(board));
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
        state.currentSlot = selected.slot;
        await vscode.workspace.getConfiguration('openblink').update('slot', state.currentSlot, vscode.ConfigurationTarget.Global);
        state.tasksProvider.update({ slot: state.currentSlot });
        ui.updateStatusBar(state.bleManager.connectionState, state.bleManager.deviceName, undefined, state.currentSlot);
        vscode.window.showInformationMessage(l10n.t('Slot set to: {0}', String(state.currentSlot)));
        ui.log(`[SYSTEM] ${l10n.t('Slot set to: {0}', String(state.currentSlot))}`);
      }
    }),
  );
}
