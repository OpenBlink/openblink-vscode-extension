/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { ConnectionState, DeviceInfo, MetricsData, MetricsHistory, MetricsStats, SavedDevice, getConsoleBufferSize, getMetricsHistorySize } from './types';

/** @brief Get the maximum number of entries retained in each metrics history array from settings. */
function getMaxMetricsHistory(): number { return getMetricsHistorySize(); }

// ============================================================================
// Output Channel
// ============================================================================

/** @brief Shared output channel instance for extension logging. */
let outputChannel: vscode.OutputChannel;

/**
 * @brief Create the "OpenBlink" output channel.
 * @returns The created {@link vscode.OutputChannel}.
 */
export function createOutputChannel(): vscode.OutputChannel {
  outputChannel = vscode.window.createOutputChannel('OpenBlink');
  return outputChannel;
}

/**
 * @brief Get the shared output channel.
 * @returns The "OpenBlink" {@link vscode.OutputChannel}.
 */
export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel;
}

/**
 * @brief Reveal the output channel once, without stealing focus.
 *
 * Intended to be called on the first user-initiated BLE operation so that
 * diagnostic and connection logs become visible without forcing the Output
 * panel open during activation.
 */
let _outputShown = false;
export function showOutputChannelOnce(): void {
  if (!_outputShown && outputChannel) {
    _outputShown = true;
    outputChannel.show(true);
  }
}

/**
 * @brief Append a line to the output channel.
 * @param message  Text to log.
 */
export function log(message: string): void {
  outputChannel?.appendLine(message);
}

// ============================================================================
// Console Output Buffer (for MCP integration)
// ============================================================================

/** @brief Get the maximum number of lines retained in the console output ring buffer from settings. */
function getMaxConsoleBuffer(): number { return getConsoleBufferSize(); }

/** @brief Ring buffer for [DEVICE] console output lines, exposed to MCP server via file IPC. */
const consoleBuffer: string[] = [];

/**
 * @brief Append a line to the in-memory console ring buffer.
 *
 * When the buffer exceeds {@link MAX_CONSOLE_BUFFER} lines, the oldest
 * entries are discarded.  The MCP bridge reads this buffer via
 * {@link getConsoleLog} to write it to the IPC file.
 *
 * @param line  A single console output line (without trailing newline).
 */
export function appendConsoleLog(line: string): void {
  consoleBuffer.push(line);
  const maxBuffer = getMaxConsoleBuffer();
  if (consoleBuffer.length > maxBuffer) {
    consoleBuffer.splice(0, consoleBuffer.length - maxBuffer);
  }
}

/**
 * @brief Return a snapshot of the console ring buffer.
 * @returns An array of the most recent console output lines (up to
 *          the configured buffer size).
 */
export function getConsoleLog(): string[] {
  return [...consoleBuffer];
}

// ============================================================================
// Diagnostics
// ============================================================================

/** @brief Shared diagnostic collection for compiler errors/warnings. */
let diagnosticCollection: vscode.DiagnosticCollection;

/**
 * @brief Create the "openblink" diagnostic collection.
 * @returns The created {@link vscode.DiagnosticCollection}.
 */
export function createDiagnosticCollection(): vscode.DiagnosticCollection {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('openblink');
  return diagnosticCollection;
}

/**
 * @brief Set diagnostics for a specific document.
 * @param uri          Document URI to associate diagnostics with.
 * @param diagnostics  Array of diagnostics to display.
 */
export function setDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
  diagnosticCollection?.set(uri, diagnostics);
}

/**
 * @brief Clear diagnostics for a specific document, or all documents.
 * @param uri  Optional document URI. If omitted, all diagnostics are cleared.
 */
export function clearDiagnostics(uri?: vscode.Uri): void {
  if (uri) {
    diagnosticCollection?.delete(uri);
  } else {
    diagnosticCollection?.clear();
  }
}

// ============================================================================
// Status Bar
// ============================================================================

/** @brief Shared status bar item showing connection state and metrics. */
let statusBarItem: vscode.StatusBarItem;

/**
 * @brief Create and show the OpenBlink status bar item.
 * @returns The created {@link vscode.StatusBarItem}.
 */
export function createStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circle-slash) OpenBlink';
  statusBarItem.tooltip = l10n.t('Not Connected');
  statusBarItem.show();
  return statusBarItem;
}

/**
 * @brief Update the status bar text and tooltip based on the current state.
 *
 * @param state          Current BLE connection state.
 * @param deviceName     Advertised device name (shown when connected).
 * @param metrics        Optional latest metrics to display inline.
 * @param slot           Optional active program slot number.
 * @param reconnectInfo  Optional reconnect attempt/max counts for the reconnecting tooltip.
 */
export function updateStatusBar(
  state: ConnectionState,
  deviceName?: string,
  metrics?: MetricsData,
  slot?: number,
  reconnectInfo?: { attempt: number; max: number }
): void {
  if (!statusBarItem) { return; }

  switch (state) {
    case 'disconnected':
      statusBarItem.text = '$(circle-slash) OpenBlink';
      statusBarItem.tooltip = l10n.t('Not Connected');
      break;
    case 'connecting':
      statusBarItem.text = '$(sync~spin) OpenBlink';
      statusBarItem.tooltip = l10n.t('Connecting to device...');
      break;
    case 'reconnecting':
      statusBarItem.text = '$(sync~spin) OpenBlink';
      statusBarItem.tooltip = reconnectInfo
        ? l10n.t('Reconnecting ({0}/{1})...', String(reconnectInfo.attempt), String(reconnectInfo.max))
        : l10n.t('Reconnecting...');
      break;
    case 'connected':
      if (metrics?.compileTime !== undefined) {
        const parts = [];
        parts.push(`${metrics.compileTime.toFixed(1)}ms`);
        if (metrics.transferTime !== undefined) {
          parts.push(`${metrics.transferTime.toFixed(1)}ms`);
        }
        if (metrics.programSize !== undefined) {
          parts.push(`${metrics.programSize}B`);
        }
        if (slot) { parts.push(`Slot ${slot}`); }
        statusBarItem.text = `$(check) ${parts.join(' | ')}`;
      } else {
        const slotStr = slot ? ` | Slot ${slot}` : '';
        statusBarItem.text = `$(check) ${deviceName ?? 'OpenBlink'}${slotStr}`;
      }
      statusBarItem.tooltip = deviceName ?? 'OpenBlink';
      break;
  }
}

// ============================================================================
// Metrics
// ============================================================================

/** @brief Rolling history of build/transfer metrics. */
const metricsHistory: MetricsHistory = {
  compile: [],
  transfer: [],
  size: [],
};

/**
 * @brief Append a value to a metrics history array, evicting old entries.
 * @param arr    Target history array.
 * @param value  Value to append.
 */
function addToHistory(arr: number[], value: number): void {
  arr.push(value);
  const max = Math.max(1, getMaxMetricsHistory());
  while (arr.length > max) { arr.shift(); }
}

/**
 * @brief Compute min / avg / max statistics for a numeric array.
 *
 * Uses a single-pass loop instead of `Math.min(...arr)` /
 * `Math.max(...arr)` to avoid stack overflow on large arrays.
 *
 * @param arr  Array of numeric values.
 * @returns {@link MetricsStats} with computed values, or nulls if the array is empty.
 */
export function calculateStats(arr: number[]): MetricsStats {
  if (arr.length === 0) { return { min: null, avg: null, max: null }; }
  let min = arr[0];
  let max = arr[0];
  let sum = 0;
  for (const v of arr) {
    if (v < min) { min = v; }
    if (v > max) { max = v; }
    sum += v;
  }
  return { min, avg: sum / arr.length, max };
}

/**
 * @brief Record a set of metrics into the rolling history.
 * @param data  Metrics from the latest build/transfer cycle.
 */
export function recordMetrics(data: MetricsData): void {
  if (data.compileTime !== undefined) { addToHistory(metricsHistory.compile, data.compileTime); }
  if (data.transferTime !== undefined) { addToHistory(metricsHistory.transfer, data.transferTime); }
  if (data.programSize !== undefined) { addToHistory(metricsHistory.size, data.programSize); }
}

/**
 * @brief Get the current metrics history.
 * @returns The {@link MetricsHistory} singleton.
 */
export function getMetricsHistory(): MetricsHistory {
  return metricsHistory;
}

// ============================================================================
// TreeView Providers
// ============================================================================

/**
 * @brief TreeDataProvider that exposes the main action items in the sidebar.
 *
 * Displays source file selection, board selection, slot selection, build,
 * reset, and disconnect entries. Device connection is handled separately
 * by {@link DevicesTreeProvider}. Refreshes automatically when
 * {@link update} is called.
 */
export class TasksTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sourceFile = 'app.rb';
  private boardName = '';
  private slot = 2;
  private connected = false;

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Update displayed state and refresh the tree view.
   * @param opts  Partial set of properties to update.
   */
  update(opts: { sourceFile?: string; boardName?: string; slot?: number; connected?: boolean }): void {
    if (opts.sourceFile !== undefined) { this.sourceFile = opts.sourceFile; }
    if (opts.boardName !== undefined) { this.boardName = opts.boardName; }
    if (opts.slot !== undefined) { this.slot = opts.slot; }
    if (opts.connected !== undefined) { this.connected = opts.connected; }
    this.refresh();
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the list of action items for the tasks view.
   * @returns Array of tree items representing available commands.
   */
  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    const source = new vscode.TreeItem(l10n.t('Select Source File ({0})', this.sourceFile));
    source.command = { command: 'openblink.selectSourceFile', title: '' };
    source.iconPath = new vscode.ThemeIcon('file-code');
    items.push(source);

    const board = new vscode.TreeItem(l10n.t('Select Board ({0})', this.boardName));
    board.command = { command: 'openblink.selectBoard', title: '' };
    board.iconPath = new vscode.ThemeIcon('circuit-board');
    items.push(board);

    const slotItem = new vscode.TreeItem(l10n.t('Select Slot ({0})', String(this.slot)));
    slotItem.command = { command: 'openblink.selectSlot', title: '' };
    slotItem.iconPath = new vscode.ThemeIcon('symbol-numeric');
    items.push(slotItem);

    const build = new vscode.TreeItem(l10n.t('Build & Blink'));
    build.command = { command: 'openblink.buildAndBlink', title: '' };
    build.iconPath = new vscode.ThemeIcon('play');
    items.push(build);

    const reset = new vscode.TreeItem(l10n.t('Soft Reset'));
    reset.command = { command: 'openblink.softReset', title: '' };
    reset.iconPath = new vscode.ThemeIcon('refresh');
    items.push(reset);

    const disconnect = new vscode.TreeItem(l10n.t('Disconnect'));
    disconnect.command = { command: 'openblink.disconnectDevice', title: '' };
    disconnect.iconPath = new vscode.ThemeIcon('debug-disconnect');
    items.push(disconnect);

    return items;
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}

/**
 * @brief TreeDataProvider that displays connected device information in the sidebar.
 *
 * Shows device name, device ID, and negotiated MTU when connected.
 * Designed for easy extension as the protocol grows.
 */
export class DeviceInfoTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private connected = false;
  private deviceName = '';
  private deviceId = '';
  private mtu = 0;

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Update displayed device info and refresh the tree view.
   * @param opts  Partial set of properties to update.
   */
  update(opts: { connected?: boolean; deviceName?: string; deviceId?: string; mtu?: number }): void {
    if (opts.connected !== undefined) { this.connected = opts.connected; }
    if (opts.deviceName !== undefined) { this.deviceName = opts.deviceName; }
    if (opts.deviceId !== undefined) { this.deviceId = opts.deviceId; }
    if (opts.mtu !== undefined) { this.mtu = opts.mtu; }
    this.refresh();
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the list of device info items for the view.
   * @returns Array of tree items showing device properties.
   */
  getChildren(): vscode.TreeItem[] {
    if (!this.connected) {
      const item = new vscode.TreeItem(l10n.t('Not Connected'));
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [item];
    }

    const items: vscode.TreeItem[] = [];

    const nameItem = new vscode.TreeItem(`${l10n.t('Device Name')}: ${this.deviceName || '--'}`);
    nameItem.iconPath = new vscode.ThemeIcon('device-mobile');
    items.push(nameItem);

    const idItem = new vscode.TreeItem(`${l10n.t('Device ID')}: ${this.deviceId || '--'}`);
    idItem.iconPath = new vscode.ThemeIcon('key');
    items.push(idItem);

    const mtuItem = new vscode.TreeItem(`MTU: ${this.mtu}`);
    mtuItem.iconPath = new vscode.ThemeIcon('symbol-ruler');
    items.push(mtuItem);

    return items;
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}

/**
 * @brief TreeDataProvider that displays compile/transfer metrics in the sidebar.
 *
 * Shows latest values and historical min/avg/max for compile time,
 * transfer time, and program size.
 */
export class MetricsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private latestMetrics: MetricsData = {};

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Update latest metric values and refresh the tree view.
   * @param data  New metrics from the latest build/transfer cycle.
   */
  updateMetrics(data: MetricsData): void {
    if (data.compileTime !== undefined) { this.latestMetrics.compileTime = data.compileTime; }
    if (data.transferTime !== undefined) { this.latestMetrics.transferTime = data.transferTime; }
    if (data.programSize !== undefined) { this.latestMetrics.programSize = data.programSize; }
    this.refresh();
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the list of metric items for the metrics view.
   * @returns Array of tree items showing compile, transfer, and size metrics.
   */
  getChildren(): vscode.TreeItem[] {
    const history = getMetricsHistory();
    const items: vscode.TreeItem[] = [];

    const compileStats = calculateStats(history.compile);
    const compileItem = new vscode.TreeItem(
      `${l10n.t('Compile')}: ${this.latestMetrics.compileTime?.toFixed(1) ?? '--'}ms`
    );
    compileItem.description = compileStats.min !== null
      ? `min: ${compileStats.min.toFixed(1)} | avg: ${compileStats.avg!.toFixed(1)} | max: ${compileStats.max!.toFixed(1)}`
      : '';
    compileItem.iconPath = new vscode.ThemeIcon('symbol-event');
    items.push(compileItem);

    const transferStats = calculateStats(history.transfer);
    const transferItem = new vscode.TreeItem(
      `${l10n.t('Transfer')}: ${this.latestMetrics.transferTime?.toFixed(1) ?? '--'}ms`
    );
    transferItem.description = transferStats.min !== null
      ? `min: ${transferStats.min.toFixed(1)} | avg: ${transferStats.avg!.toFixed(1)} | max: ${transferStats.max!.toFixed(1)}`
      : '';
    transferItem.iconPath = new vscode.ThemeIcon('cloud-upload');
    items.push(transferItem);

    const sizeStats = calculateStats(history.size);
    const sizeItem = new vscode.TreeItem(
      `${l10n.t('Size')}: ${this.latestMetrics.programSize ?? '--'}B`
    );
    sizeItem.description = sizeStats.min !== null
      ? `min: ${sizeStats.min} | avg: ${Math.round(sizeStats.avg!)} | max: ${sizeStats.max}`
      : '';
    sizeItem.iconPath = new vscode.ThemeIcon('file-binary');
    items.push(sizeItem);

    return items;
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}

// ============================================================================
// Devices TreeView
// ============================================================================

/**
 * @brief Unique identifier for a tree item in the devices view.
 *
 * Encodes the section (scanning / saved), the device ID, and an
 * optional contextValue so that context menus work correctly.
 */
class DeviceTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly deviceId: string,
    public readonly section: 'scanning' | 'saved',
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

/**
 * @brief TreeDataProvider that displays BLE devices in the sidebar.
 *
 * Sections:
 * - **Scanning**: shown while a scan is active with a spinning animation;
 *   lists discovered peripherals in real time.
 * - **Saved Devices**: previously connected devices persisted in
 *   `globalState`. Each entry can be connected to or deleted.
 *
 * The currently connected device is highlighted with a pulsing icon.
 */
export class DevicesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** @brief Whether a BLE scan is in progress. */
  private scanning = false;
  /** @brief Devices found during the active scan. */
  private scannedDevices: DeviceInfo[] = [];
  /** @brief Devices persisted from previous connections. */
  private savedDevices: SavedDevice[] = [];
  /** @brief Peripheral ID of the currently connected device, or empty. */
  private connectedDeviceId = '';
  /** @brief Current connection state for animation. */
  private connectionState: ConnectionState = 'disconnected';

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Replace the saved-device list and refresh.
   * @param devices  Full list loaded from globalState.
   */
  setSavedDevices(devices: SavedDevice[]): void {
    this.savedDevices = [...devices];
    this.refresh();
  }

  /**
   * @brief Update scanning state and refresh.
   * @param isScanning  Whether a scan is currently in progress.
   */
  updateScanning(isScanning: boolean): void {
    this.scanning = isScanning;
    if (isScanning) { this.scannedDevices = []; }
    this.refresh();
  }

  /**
   * @brief Add a newly discovered device and refresh.
   * @param info  Device information from the BLE scan callback.
   */
  addDiscoveredDevice(info: DeviceInfo): void {
    if (!this.scannedDevices.some(d => d.id === info.id)) {
      this.scannedDevices.push(info);
      this.refresh();
    }
  }

  /**
   * @brief Update connection status and refresh.
   * @param state     Current connection state.
   * @param deviceId  Peripheral ID of the connected device.
   */
  updateConnection(state: ConnectionState, deviceId: string): void {
    this.connectionState = state;
    if (deviceId) {
      this.connectedDeviceId = deviceId;
    } else if (state === 'disconnected') {
      this.connectedDeviceId = '';
    }
    // When state is 'connecting' and deviceId is empty (from BleManager callback
    // before currentDevice is set), keep the previously set connectedDeviceId
    // so the animation shows on the correct item.
    this.refresh();
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the tree structure for the devices view.
   *
   * Without a parent element, returns the two top-level sections
   * (Discovered Devices and Saved Devices).  When called with a
   * section header, returns the device items belonging to that section.
   *
   * @param element  Optional parent tree item.
   * @returns Array of child tree items.
   */
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // Top-level: return section headers
    if (!element) {
      const sections: vscode.TreeItem[] = [];

      // Scanning section
      const scanLabel = this.scanning
        ? l10n.t('Scanning...')
        : l10n.t('Discovered Devices');
      const scanSection = new vscode.TreeItem(scanLabel, vscode.TreeItemCollapsibleState.Expanded);
      scanSection.iconPath = this.scanning
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon('search');
      scanSection.contextValue = 'devicesSection-scan';
      sections.push(scanSection);

      // Saved devices section
      const savedSection = new vscode.TreeItem(
        l10n.t('Saved Devices'),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      savedSection.iconPath = new vscode.ThemeIcon('bookmark');
      savedSection.contextValue = 'devicesSection-saved';
      sections.push(savedSection);

      return sections;
    }

    // Children of "Scanning / Discovered Devices"
    if (element.contextValue === 'devicesSection-scan') {
      if (this.scannedDevices.length === 0) {
        const empty = new vscode.TreeItem(
          this.scanning ? l10n.t('Searching...') : l10n.t('No devices found'),
        );
        empty.iconPath = this.scanning
          ? new vscode.ThemeIcon('loading~spin')
          : new vscode.ThemeIcon('circle-slash');
        return [empty];
      }
      return this.scannedDevices.map(d => this.makeScannedItem(d));
    }

    // Children of "Saved Devices"
    if (element.contextValue === 'devicesSection-saved') {
      if (this.savedDevices.length === 0) {
        const empty = new vscode.TreeItem(l10n.t('No saved devices'));
        empty.iconPath = new vscode.ThemeIcon('circle-slash');
        return [empty];
      }
      return this.savedDevices.map(d => this.makeSavedItem(d));
    }

    return [];
  }

  /**
   * @brief Build a tree item for a scanned (discovered) device.
   *
   * Shows a spinner when connecting, a green check when connected,
   * or a device icon otherwise.
   *
   * @param info  Discovered device information from the BLE scan.
   * @returns A configured {@link DeviceTreeItem}.
   */
  private makeScannedItem(info: DeviceInfo): DeviceTreeItem {
    const isConnected = info.id === this.connectedDeviceId;
    const isConnecting = info.id === this.connectedDeviceId && this.connectionState === 'connecting';
    const label = info.name ? `${info.name}(${info.id})` : info.id;
    const item = new DeviceTreeItem(label, info.id, 'scanning');

    if (isConnecting || (this.connectionState === 'reconnecting' && isConnected)) {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.description = l10n.t('Connecting...');
    } else if (isConnected) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
      item.description = l10n.t('Connected');
    } else {
      item.iconPath = new vscode.ThemeIcon('device-mobile');
    }

    item.command = { command: 'openblink.connectScannedDevice', title: '', arguments: [info.id] };
    item.contextValue = isConnected ? 'scannedDevice-connected' : 'scannedDevice';
    item.tooltip = `ID: ${info.id}`;
    return item;
  }

  /**
   * @brief Build a tree item for a saved (previously connected) device.
   *
   * Shows a spinner when connecting, a green check when connected,
   * or a history icon otherwise.
   *
   * @param saved  Persisted device record from globalState.
   * @returns A configured {@link DeviceTreeItem}.
   */
  private makeSavedItem(saved: SavedDevice): DeviceTreeItem {
    const isConnected = saved.id === this.connectedDeviceId;
    const isConnecting = (this.connectionState === 'connecting' || this.connectionState === 'reconnecting')
      && saved.id === this.connectedDeviceId;
    const label = saved.name ? `${saved.name}(${saved.id})` : saved.id;
    const item = new DeviceTreeItem(label, saved.id, 'saved');

    if (isConnecting) {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.description = l10n.t('Connecting...');
    } else if (isConnected) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
      item.description = l10n.t('Connected');
    } else {
      item.iconPath = new vscode.ThemeIcon('history');
    }

    item.command = { command: 'openblink.connectSavedDevice', title: '', arguments: [saved.id] };
    item.contextValue = isConnected ? 'savedDevice-connected' : 'savedDevice';
    item.tooltip = `ID: ${saved.id}`;
    return item;
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}

// ============================================================================
// Board Reference TreeView
// ============================================================================

/**
 * @brief Tree item representing a reference section (## heading) with child entries.
 */
class ReferenceSectionItem extends vscode.TreeItem {
  constructor(label: string, public readonly entries: string[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('symbol-class');
  }
}

/**
 * @brief TreeDataProvider that displays the selected board's API reference in the sidebar.
 *
 * Parses a localized Markdown reference file and presents ## sections as
 * collapsible parent nodes with their bullet-point entries as leaf items.
 */
export class BoardReferenceTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sections: ReferenceSectionItem[] = [];

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Load and parse the reference Markdown file, then refresh the tree view.
   * @param filePath  Absolute path to the reference Markdown file.
   */
  updateReference(filePath: string): void {
    this.sections = [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.sections = this.parseMarkdown(content);
    } catch {
      // Reference file not found or unreadable
    }
    this.refresh();
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the tree items for the board reference view.
   *
   * When called without an element, returns top-level section headings.
   * When called with a {@link ReferenceSectionItem}, returns its child entries.
   *
   * @param element  Optional parent element.
   * @returns Array of tree items.
   */
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      if (this.sections.length === 0) {
        const item = new vscode.TreeItem(l10n.t('No board selected'));
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        return [item];
      }
      return this.sections;
    }

    if (element instanceof ReferenceSectionItem) {
      return element.entries.map(entry => {
        const item = new vscode.TreeItem(entry);
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        return item;
      });
    }

    return [];
  }

  /**
   * @brief Parse Markdown content into reference sections.
   *
   * Recognises `## Heading` lines as section boundaries and `- content`
   * lines as entries within the current section.
   *
   * @param content  Raw Markdown string.
   * @returns Array of parsed {@link ReferenceSectionItem} objects.
   */
  private parseMarkdown(content: string): ReferenceSectionItem[] {
    const sections: ReferenceSectionItem[] = [];
    let currentHeading = '';
    let currentEntries: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('## ')) {
        if (currentHeading && currentEntries.length > 0) {
          sections.push(new ReferenceSectionItem(currentHeading, currentEntries));
        }
        currentHeading = trimmed.substring(3).trim();
        currentEntries = [];
      } else if (trimmed.startsWith('- ') && currentHeading) {
        // Strip leading "- " and inline backticks for cleaner display
        const entry = trimmed.substring(2).replace(/`/g, '');
        currentEntries.push(entry);
      }
    }

    // Push the last section
    if (currentHeading && currentEntries.length > 0) {
      sections.push(new ReferenceSectionItem(currentHeading, currentEntries));
    }

    return sections;
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}

// ============================================================================
// MCP Status TreeView
// ============================================================================

/**
 * @brief Execution state of an MCP history entry.
 *
 * - `pending`  — Request received; handler is still running.
 * - `success`  — Handler completed and the operation succeeded.
 * - `failed`   — Handler completed but the operation failed (or threw).
 */
export type McpHistoryStatus = 'pending' | 'success' | 'failed';

/**
 * @brief A single AI-agent-initiated operation recorded in the MCP status view.
 *
 * One entry is appended per `trigger.json` or `command.json` observed by the
 * extension.  Entries start in `pending` and transition to `success`/`failed`
 * once the handler writes its `result.json` / `command-result.json`.
 */
export interface McpHistoryEntry {
  /** @brief When the request was first observed by the extension. */
  timestamp: Date;
  /** @brief MCP tool or command name (e.g. `build_and_blink`, `scan_devices`). */
  tool: string;
  /** @brief Request ID used to correlate the request with its result. */
  requestId: string;
  /** @brief Short human-readable parameter summary (e.g. `app.rb`, `deviceId=AA:BB`). */
  summary: string;
  /** @brief Current execution state. */
  status: McpHistoryStatus;
  /** @brief Optional detail shown in the tooltip (success details or error message). */
  detail?: string;
  /** @brief End-to-end wall-clock duration in milliseconds (set on completion). */
  durationMs?: number;
}

/** @brief Section header under which history entries appear as children. */
class McpHistorySectionItem extends vscode.TreeItem {
  constructor(count: number) {
    super(`${l10n.t('History')} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = 'mcpHistorySection';
    this.iconPath = new vscode.ThemeIcon('history');
    this.contextValue = 'mcpHistorySection';
  }
}

/**
 * @brief TreeDataProvider that displays MCP integration status in the sidebar.
 *
 * Shows whether MCP is enabled, IPC file activity timestamps, the last
 * build request received from the MCP server, and a rolling history of
 * AI-agent-initiated tool invocations.
 *
 * The history section is rendered as a **collapsible** group so it does
 * not interrupt the top-level status summary; users expand it on demand.
 */
export class McpStatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** @brief Maximum history entries retained in memory. */
  private static readonly MAX_HISTORY = 50;

  private mcpEnabled = true;
  private lastTriggerTime: Date | null = null;
  private lastTriggerRequestId: string | null = null;
  private lastResultTime: Date | null = null;
  private lastResultSuccess: boolean | null = null;
  private lastResultError: string | undefined;
  private lastStatusWriteTime: Date | null = null;
  private lastConsoleWriteTime: Date | null = null;
  /** @brief Ring of most-recent AI-triggered operations, newest first. */
  private history: McpHistoryEntry[] = [];

  /** @brief Trigger a tree view refresh. */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /**
   * @brief Update displayed MCP status and refresh the tree view.
   * @param opts  Partial set of properties to update.
   */
  update(opts: {
    mcpEnabled?: boolean;
    lastTriggerTime?: Date;
    lastTriggerRequestId?: string;
    lastResultTime?: Date;
    lastResultSuccess?: boolean;
    lastResultError?: string;
    lastStatusWriteTime?: Date;
    lastConsoleWriteTime?: Date;
  }): void {
    if (opts.mcpEnabled !== undefined) { this.mcpEnabled = opts.mcpEnabled; }
    if (opts.lastTriggerTime !== undefined) { this.lastTriggerTime = opts.lastTriggerTime; }
    if (opts.lastTriggerRequestId !== undefined) { this.lastTriggerRequestId = opts.lastTriggerRequestId; }
    if (opts.lastResultTime !== undefined) { this.lastResultTime = opts.lastResultTime; }
    if (opts.lastResultSuccess !== undefined) { this.lastResultSuccess = opts.lastResultSuccess; }
    if (opts.lastResultError !== undefined) { this.lastResultError = opts.lastResultError; }
    if (opts.lastStatusWriteTime !== undefined) { this.lastStatusWriteTime = opts.lastStatusWriteTime; }
    if (opts.lastConsoleWriteTime !== undefined) { this.lastConsoleWriteTime = opts.lastConsoleWriteTime; }
    this.refresh();
  }

  /**
   * @brief Append a new (pending) history entry and refresh the tree view.
   *
   * Called when a `trigger.json` or `command.json` is received.  Use
   * {@link updateHistoryEntry} with the same `requestId` to mark the
   * entry as success/failed once the handler completes.
   *
   * @param entry  Tool/requestId/summary; timestamp and status are set
   *               automatically (`status = 'pending'`).
   */
  addHistoryEntry(entry: Pick<McpHistoryEntry, 'tool' | 'requestId' | 'summary'>): void {
    const full: McpHistoryEntry = {
      ...entry,
      timestamp: new Date(),
      status: 'pending',
    };
    this.history.unshift(full);
    if (this.history.length > McpStatusTreeProvider.MAX_HISTORY) {
      this.history.splice(McpStatusTreeProvider.MAX_HISTORY);
    }
    this.refresh();
  }

  /**
   * @brief Transition a pending history entry to success/failed.
   *
   * Looks up the entry by `requestId`; if not found (e.g. the ring has
   * evicted it), the update is silently dropped.
   */
  updateHistoryEntry(
    requestId: string,
    update: Partial<Pick<McpHistoryEntry, 'status' | 'detail' | 'durationMs'>>,
  ): void {
    const entry = this.history.find(e => e.requestId === requestId);
    if (!entry) { return; }
    if (update.status !== undefined) { entry.status = update.status; }
    if (update.detail !== undefined) { entry.detail = update.detail; }
    if (update.durationMs !== undefined) { entry.durationMs = update.durationMs; }
    this.refresh();
  }

  /** @brief Remove all history entries. */
  clearHistory(): void {
    this.history = [];
    this.refresh();
  }

  /** @brief Snapshot the current history (for tests or diagnostics). */
  getHistory(): ReadonlyArray<McpHistoryEntry> {
    return this.history;
  }

  /** @brief Return the tree item itself (no transformation needed). */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  /**
   * @brief Build the tree structure for the MCP status view.
   *
   * - Top-level: enabled/disabled, file-write timestamps, last
   *   request/result, and a collapsible `History (n)` section when any
   *   entries exist.
   * - Children of the history section: one item per logged invocation,
   *   most recent first.
   */
  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      return this.buildTopLevel();
    }
    if (element.contextValue === 'mcpHistorySection') {
      if (this.history.length === 0) {
        const empty = new vscode.TreeItem(l10n.t('No MCP activity yet'));
        empty.iconPath = new vscode.ThemeIcon('circle-slash');
        return [empty];
      }
      return this.history.map(e => this.makeHistoryItem(e));
    }
    return [];
  }

  /** @brief Build the top-level (always-visible) tree items. */
  private buildTopLevel(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    // MCP enabled/disabled
    const enabledItem = new vscode.TreeItem(
      `MCP: ${this.mcpEnabled ? l10n.t('Enabled') : l10n.t('Disabled')}`
    );
    enabledItem.iconPath = this.mcpEnabled
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-slash');
    enabledItem.command = { command: 'workbench.action.openSettings', title: '', arguments: ['openblink.mcp.enabled'] };
    items.push(enabledItem);

    if (!this.mcpEnabled) {
      return items;
    }

    // Status file write time
    const statusItem = new vscode.TreeItem(
      `${l10n.t('Status File')}: ${this.fmtTime(this.lastStatusWriteTime)}`
    );
    statusItem.iconPath = new vscode.ThemeIcon(this.lastStatusWriteTime ? 'file-symlink-file' : 'file');
    items.push(statusItem);

    // Console log write time
    const consoleItem = new vscode.TreeItem(
      `${l10n.t('Console Log')}: ${this.fmtTime(this.lastConsoleWriteTime)}`
    );
    consoleItem.iconPath = new vscode.ThemeIcon(this.lastConsoleWriteTime ? 'output' : 'file');
    items.push(consoleItem);

    // Last build request (trigger from MCP server)
    const triggerItem = new vscode.TreeItem(
      `${l10n.t('Last Request')}: ${this.fmtTime(this.lastTriggerTime)}`
    );
    triggerItem.iconPath = new vscode.ThemeIcon('arrow-down');
    if (this.lastTriggerRequestId) {
      triggerItem.description = this.lastTriggerRequestId;
    }
    items.push(triggerItem);

    // Last build result
    const resultLabel = this.lastResultSuccess !== null
      ? `${l10n.t('Last Result')}: ${this.lastResultSuccess ? l10n.t('Success') : l10n.t('Failed')}`
      : `${l10n.t('Last Result')}: --`;
    const resultItem = new vscode.TreeItem(resultLabel);
    if (this.lastResultSuccess === true) {
      resultItem.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else if (this.lastResultSuccess === false) {
      resultItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      resultItem.iconPath = new vscode.ThemeIcon('circle-slash');
    }
    if (this.lastResultTime) {
      resultItem.description = this.fmtTime(this.lastResultTime);
    }
    if (this.lastResultSuccess === false && this.lastResultError) {
      resultItem.tooltip = this.lastResultError;
    }
    items.push(resultItem);

    // History (collapsible, always visible).  Rendered as a child of the
    // top-level list so users can see the section and its current count
    // even before the first AI tool invocation; an empty placeholder is
    // shown when `history.length === 0`.
    items.push(new McpHistorySectionItem(this.history.length));

    return items;
  }

  /**
   * @brief Build a single history entry's tree item.
   *
   * Label: `HH:MM:SS  <tool>`
   * Description: `<summary>  (<durationMs>ms)`
   * Tooltip: detail (success info or error message)
   * Icon: spinner (pending) / check (success) / error (failed)
   */
  private makeHistoryItem(entry: McpHistoryEntry): vscode.TreeItem {
    const timeStr = entry.timestamp.toLocaleTimeString();
    const item = new vscode.TreeItem(`${timeStr}  ${entry.tool}`);

    if (entry.status === 'pending') {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (entry.status === 'success') {
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    }

    const parts: string[] = [];
    if (entry.summary) { parts.push(entry.summary); }
    if (entry.durationMs !== undefined) { parts.push(`${entry.durationMs}ms`); }
    item.description = parts.join('  ');

    const tooltipLines = [
      `${entry.tool}`,
      `${l10n.t('Request ID')}: ${entry.requestId}`,
      `${l10n.t('Status')}: ${entry.status}`,
    ];
    if (entry.summary) { tooltipLines.push(`${l10n.t('Params')}: ${entry.summary}`); }
    if (entry.durationMs !== undefined) { tooltipLines.push(`${l10n.t('Duration')}: ${entry.durationMs}ms`); }
    if (entry.detail) { tooltipLines.push('', entry.detail); }
    item.tooltip = tooltipLines.join('\n');

    item.contextValue = `mcpHistoryItem-${entry.status}`;
    return item;
  }

  /**
   * @brief Format a Date as a locale-appropriate time string.
   * @param date  Date to format, or null.
   * @returns Formatted time string or '--' if null.
   */
  private fmtTime(date: Date | null): string {
    if (!date) { return '--'; }
    return date.toLocaleTimeString();
  }

  /** @brief Dispose the internal event emitter. */
  dispose(): void { this._onDidChangeTreeData.dispose(); }
}
