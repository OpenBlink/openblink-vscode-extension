/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import { EventEmitter } from 'vscode';
import * as l10n from '@vscode/l10n';
import type { Peripheral, Characteristic } from '@abandonware/noble';
import {
  ConnectionState,
  DeviceInfo,
  NoblePeripheral,
  NobleService,
  NobleCharacteristic,
  BLE_CONSTANTS,
  getBleScanTimeout,
  getBleConnectionTimeout,
  getBleMaxReconnectAttempts,
  getBleInitialReconnectDelay,
  getBleRequestedMtu,
  getBleDefaultMtu,
} from './types';

/**
 * @brief Extended Noble module type with runtime state properties and async scan helpers.
 *
 * Declared as a standalone interface (rather than `typeof noble & { ... }`) to
 * support lazy-loading of the native noble module.  Only the subset of the
 * Noble API actually used by {@link BleManager} is listed here.
 */
interface NobleWithState {
  state: 'poweredOn' | 'poweredOff' | 'unknown';
  initialized: boolean;
  scanning: boolean;
  startScanningAsync: (serviceUUIDs?: string[], allowDuplicates?: boolean) => Promise<void>;
  stopScanningAsync: () => Promise<void>;
  on(event: 'stateChange', callback: (state: string) => void): void;
  on(event: 'discover', callback: (peripheral: Peripheral) => void): void;
  removeListener(event: 'stateChange', callback: (state: string) => void): void;
  removeListener(event: 'discover', callback: (peripheral: Peripheral) => void): void;
}

/** @brief Lazily resolved Noble module instance. */
let _noble: NobleWithState | undefined;

/**
 * @brief Lazy-load the @abandonware/noble native module.
 *
 * Defers loading of the heavy native BLE module until BLE operations are
 * actually requested, avoiding its cost during extension activation.
 *
 * @returns The Noble module cast to {@link NobleWithState}.
 */
function getNoble(): NobleWithState {
  if (!_noble) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _noble = require('@abandonware/noble') as NobleWithState;
    } catch (error) {
      throw new Error(
        l10n.t('Failed to load Bluetooth module. BLE support may not be available on this platform.'),
        { cause: error },
      );
    }
  }
  return _noble;
}

/**
 * @brief Manages BLE connectivity to OpenBlink-compatible devices.
 *
 * Provides separate APIs for device scanning ({@link startScan},
 * {@link stopScan}) and connection ({@link connectById}).  Discovered
 * devices are emitted via {@link onDeviceDiscovered} and accumulated in
 * {@link discoveredDevices}.  Connection state changes are broadcast
 * through {@link onConnectionStateChanged}.  Internally handles GATT
 * service/characteristic discovery, MTU negotiation, automatic
 * reconnection with exponential back-off, and console output forwarding.
 */
export class BleManager {
  /** @brief BLE characteristic for writing program data. */
  private programCharacteristic: NobleCharacteristic | null = null;
  /** @brief BLE characteristic for receiving console output. */
  private consoleCharacteristic: NobleCharacteristic | null = null;
  /** @brief BLE characteristic for reading the negotiated MTU. */
  private negotiatedMtuCharacteristic: NobleCharacteristic | null = null;
  /** @brief Currently connected peripheral, or null if disconnected. */
  private currentDevice: NoblePeripheral | null = null;
  /** @brief Current connection state. */
  private _connectionState: ConnectionState = 'disconnected';
  /** @brief Number of reconnection attempts performed so far. */
  private reconnectAttempts = 0;
  /** @brief Flag to suppress auto-reconnect after a user-initiated disconnect. */
  private userInitiatedDisconnect = false;
  /** @brief Effective MTU for data payloads. */
  private _negotiatedMTU = getBleDefaultMtu();
  /** @brief Bound handler for console data events, stored for proper removal. */
  private consoleDataHandler: ((data: Buffer) => void) | null = null;
  /** @brief Guard flag to prevent concurrent connectById() calls. */
  private _isConnecting = false;
  /** @brief Whether the manager has been disposed. */
  private _disposed = false;
  /** @brief Handle for the pending reconnect timer, if any. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** @brief Whether a BLE scan is currently active. */
  private _isScanning = false;
  /** @brief Devices discovered during the current or most recent scan. */
  private _discoveredDevices: Map<string, DeviceInfo> = new Map();
  /** @brief Handle for the scan timeout timer. */
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  /** @brief Bound handler for Noble 'discover' events, stored for proper removal. */
  private discoverHandler: ((peripheral: Peripheral) => void) | null = null;

  /** @brief Fires when the connection state changes. */
  private readonly _onConnectionStateChanged = new EventEmitter<ConnectionState>();
  readonly onConnectionStateChanged = this._onConnectionStateChanged.event;

  /** @brief Fires when console output is received from the device. */
  private readonly _onConsoleOutput = new EventEmitter<string>();
  readonly onConsoleOutput = this._onConsoleOutput.event;

  /** @brief Fires when internal log messages are produced. */
  private readonly _onLog = new EventEmitter<string>();
  readonly onLog = this._onLog.event;

  /** @brief Fires when the scanning state changes. */
  private readonly _onScanningStateChanged = new EventEmitter<boolean>();
  readonly onScanningStateChanged = this._onScanningStateChanged.event;

  /** @brief Fires when a new device is discovered during scanning. */
  private readonly _onDeviceDiscovered = new EventEmitter<DeviceInfo>();
  readonly onDeviceDiscovered = this._onDeviceDiscovered.event;

  /** @brief Current connection state. */
  get connectionState(): ConnectionState { return this._connectionState; }
  /** @brief Negotiated BLE MTU size in bytes. */
  get negotiatedMTU(): number { return this._negotiatedMTU; }
  /** @brief Whether a device is currently connected and ready. */
  get isConnected(): boolean { return this._connectionState === 'connected' && this.currentDevice !== null; }
  /** @brief Whether a BLE scan is currently active. */
  get isScanning(): boolean { return this._isScanning; }
  /** @brief Current reconnect attempt count and maximum for UI display. */
  get reconnectInfo(): { attempt: number; max: number } {
    return { attempt: this.reconnectAttempts, max: getBleMaxReconnectAttempts() };
  }
  /** @brief Devices discovered during the current or most recent scan. */
  get discoveredDevices(): ReadonlyMap<string, DeviceInfo> { return this._discoveredDevices; }
  /** @brief Advertised local name of the connected device. */
  get deviceName(): string { return this.currentDevice?.advertisement?.localName ?? ''; }
  /** @brief Unique identifier of the connected peripheral. */
  get deviceId(): string { return this.currentDevice?.id ?? ''; }

  /**
   * @brief Get the program characteristic for firmware transfer.
   * @returns The program BLE characteristic, or null if not connected.
   */
  getProgramCharacteristic(): NobleCharacteristic | null { return this.programCharacteristic; }

  /**
   * @brief Update the connection state and notify listeners.
   * @param state  New connection state.
   */
  private setConnectionState(state: ConnectionState): void {
    if (this._disposed) { return; }
    this._connectionState = state;
    this._onConnectionStateChanged.fire(state);
  }

  /**
   * @brief Emit an internal log message.
   * @param message  Log message text.
   */
  private log(message: string): void {
    if (this._disposed) { return; }
    this._onLog.fire(message);
  }

  /**
   * @brief Wait for the Bluetooth adapter to reach "poweredOn" state.
   *
   * @throws Error if Bluetooth initialization times out or the adapter is off.
   */
  private async ensureAdapterReady(): Promise<void> {
    const noble = getNoble();
    this.log(`[BLE] Noble state: ${noble.state}`);

    if (noble.state === 'poweredOn') { return; }

    this.log(`[BLE] Waiting for Bluetooth adapter initialization...`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.removeListener('stateChange', stateHandler);
        this.log(`[BLE] Bluetooth init timeout. Current state: ${noble.state}`);
        this.log(`[BLE] Troubleshooting: Check Bluetooth is enabled in System Settings.`);
        this.log(`[BLE] On macOS: System Settings > Privacy & Security > Bluetooth`);
        this.log(`[BLE] On Linux: Ensure BlueZ is running (sudo systemctl status bluetooth)`);
        reject(new Error(l10n.t('Bluetooth initialization timeout') + ` (state: ${noble.state})`));
      }, BLE_CONSTANTS.BLUETOOTH_INIT_TIMEOUT); // Bluetooth init is not configurable (platform dependent)

      const stateHandler = (state: string) => {
        this.log(`[BLE] Bluetooth state changed: ${state}`);
        if (state === 'poweredOn') {
          clearTimeout(timeout);
          noble.removeListener('stateChange', stateHandler);
          resolve();
        } else if (state === 'poweredOff') {
          clearTimeout(timeout);
          noble.removeListener('stateChange', stateHandler);
          reject(new Error(l10n.t('Bluetooth is powered off')));
        }
      };

      noble.on('stateChange', stateHandler);

      // Check again in case state changed between our check and listener registration
      if (noble.state === 'poweredOn') {
        clearTimeout(timeout);
        noble.removeListener('stateChange', stateHandler);
        resolve();
      }
    });
  }

  /**
   * @brief Start scanning for OpenBlink devices.
   *
   * Discovered devices are emitted via {@link onDeviceDiscovered} and
   * accumulated in {@link discoveredDevices}. Scanning stops automatically
   * after the configured scan timeout.
   *
   * @throws Error if Bluetooth initialization times out or the adapter is off.
   */
  async startScan(): Promise<void> {
    if (this._isScanning) { return; }

    await this.ensureAdapterReady();

    const noble = getNoble();

    // Remove our own discover listener to prevent duplicates
    this.removeDiscoverListener();

    this._discoveredDevices.clear();
    this._isScanning = true;
    this._onScanningStateChanged.fire(true);
    this.log(`[BLE] Bluetooth adapter ready. ${l10n.t('Starting device search...')}`);

    this.discoverHandler = (peripheral: Peripheral) => {
      if (!this._discoveredDevices.has(peripheral.id)) {
        const info: DeviceInfo = {
          name: peripheral.advertisement.localName || peripheral.id,
          id: peripheral.id,
          peripheral: peripheral as NoblePeripheral,
        };
        this._discoveredDevices.set(peripheral.id, info);
        this._onDeviceDiscovered.fire(info);
      }
    };
    noble.on('discover', this.discoverHandler);

    await noble.startScanningAsync([BLE_CONSTANTS.OPENBLINK_SERVICE_UUID]);

    this.scanTimer = setTimeout(() => {
      this.stopScan();
    }, getBleScanTimeout());
  }

  /**
   * @brief Stop an active BLE scan.
   */
  async stopScan(): Promise<void> {
    if (!this._isScanning) { return; }

    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }

    const noble = getNoble();
    try {
      await noble.stopScanningAsync();
    } catch {
      // Scan may already be stopped
    }
    this.removeDiscoverListener();

    this._isScanning = false;
    this._onScanningStateChanged.fire(false);
    this.log(`[BLE] ${l10n.t('Device search completed')}`);
  }

  /**
   * @brief Connect to a device by its peripheral ID.
   *
   * Looks up the device in the discovered devices map or in
   * a previously saved peripheral reference, then establishes a
   * full connection.
   *
   * @param deviceId  The peripheral ID to connect to.
   * @throws Error if the device is not found or connection fails.
   */
  async connectById(deviceId: string): Promise<void> {
    if (this._isConnecting || this.isConnected) {
      return;
    }
    this._isConnecting = true;
    this.setConnectionState('connecting');
    this.userInitiatedDisconnect = false;
    this.reconnectAttempts = 0;

    try {
      await this.ensureAdapterReady();

      const info = this._discoveredDevices.get(deviceId);
      if (!info) {
        throw new Error(l10n.t('Device not found. Please scan again.'));
      }

      // Stop scanning if active
      await this.stopScan();

      await this.connectToDevice(info.peripheral);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`[BLE] Error: ${msg}`);
      // Clean up BLE connection to prevent resource leaks when post-connect setup fails
      if (this.currentDevice) {
        try { await this.currentDevice.disconnectAsync(); } catch { /* ignore */ }
        this.currentDevice = null;
      }
      this.removeConsoleListener();
      this.programCharacteristic = null;
      this.consoleCharacteristic = null;
      this.negotiatedMtuCharacteristic = null;
      this._negotiatedMTU = getBleDefaultMtu();
      this.setConnectionState('disconnected');
      throw error;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * @brief Establish a full connection to the given peripheral.
   *
   * Attempts to connect with a timeout of the configured connection timeout
   * to prevent hanging when the device is not advertising (e.g. after a
   * previous disconnection without device restart).  If the timeout fires,
   * the pending connection attempt is cancelled via `disconnectAsync` and the
   * error is re-thrown to the caller.
   *
   * On successful connection, registers a disconnect handler immediately
   * to avoid missing events during setup, then performs GATT service and
   * characteristic discovery, subscribes to console notifications, and
   * negotiates the MTU.
   *
   * @param device  The Noble peripheral to connect to.
   * @throws Error if the connection times out, or the OpenBlink service or
   *         required characteristics are missing.
   */
  private async connectToDevice(device: NoblePeripheral): Promise<void> {
    // Connect with timeout to avoid hanging when the device is not advertising
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        device.connectAsync(),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(() => {
            reject(new Error(l10n.t('Connection timeout')));
          }, getBleConnectionTimeout());
        }),
      ]);
    } catch (error) {
      // Cancel any pending BLE connection attempt
      try { await device.disconnectAsync(); } catch { /* ignore */ }
      throw error;
    } finally {
      if (connectTimer) { clearTimeout(connectTimer); }
    }
    this.currentDevice = device;

    // Register disconnect handler immediately to avoid missing events during setup
    device.once('disconnect', () => this.handleDisconnect());

    // Discover services
    const services = await device.discoverServicesAsync();
    const openBlinkService = services.find(
      (s) => s.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_SERVICE_UUID
    ) as NobleService | undefined;

    if (!openBlinkService) {
      throw new Error(l10n.t('OpenBlink service not found'));
    }

    // Discover characteristics
    const characteristics = await new Promise<Characteristic[]>((resolve, reject) => {
      const onDiscover = (chars: Characteristic[]) => {
        clearTimeout(timer);
        resolve(chars);
      };
      const timer = setTimeout(() => {
        openBlinkService.removeListener('characteristicsDiscover', onDiscover);
        reject(new Error(l10n.t('Required characteristics not found')));
      }, BLE_CONSTANTS.CHARACTERISTIC_DISCOVERY_TIMEOUT); // Not configurable - GATT protocol timing
      openBlinkService.once('characteristicsDiscover', onDiscover);
      openBlinkService.discoverCharacteristics();
    });

    this.consoleCharacteristic = characteristics.find(
      (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_CONSOLE_CHARACTERISTIC_UUID
    ) as NobleCharacteristic | undefined ?? null;

    this.programCharacteristic = characteristics.find(
      (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_PROGRAM_CHARACTERISTIC_UUID
    ) as NobleCharacteristic | undefined ?? null;

    this.negotiatedMtuCharacteristic = characteristics.find(
      (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_MTU_CHARACTERISTIC_UUID
    ) as NobleCharacteristic | undefined ?? null;

    if (!this.consoleCharacteristic || !this.programCharacteristic || !this.negotiatedMtuCharacteristic) {
      throw new Error(l10n.t('Required characteristics not found'));
    }

    // Remove previous console listener to prevent duplicates on reconnect
    this.removeConsoleListener();

    // Setup console notifications
    await this.consoleCharacteristic.subscribeAsync();
    this.consoleDataHandler = (data: Buffer) => {
      const value = new TextDecoder().decode(data);
      this._onConsoleOutput.fire(value);
    };
    this.consoleCharacteristic.on('data', this.consoleDataHandler);

    // MTU negotiation
    await this.negotiateMTU(device);

    this.setConnectionState('connected');
    this.log(`[BLE] ${l10n.t('Connected to device: {0}', device.advertisement?.localName ?? 'Unknown')}`);
  }

  /**
   * @brief Negotiate the BLE MTU with the connected device.
   *
   * Attempts GATT-level MTU negotiation first (`gatt.requestMTU`). If
   * unavailable, falls back to reading the device's advertised MTU from
   * the dedicated characteristic. On failure, resets to the configured default MTU.
   *
   * The final value is clamped to at least MIN_USABLE_MTU
   * to guarantee that data packets always carry at least one payload byte.
   *
   * @param device  The connected Noble peripheral.
   */
  private async negotiateMTU(device: NoblePeripheral): Promise<void> {
    try {
      if (device.gatt?.requestMTU) {
        this._negotiatedMTU = await device.gatt.requestMTU(getBleRequestedMtu());
      } else if (this.negotiatedMtuCharacteristic) {
        const buffer = await this.negotiatedMtuCharacteristic.readAsync();
        if (buffer.length >= 2) {
          const deviceMtu = buffer.readUInt16LE(0);
          this._negotiatedMTU = deviceMtu - 3;
        }
      }
    } catch {
      this._negotiatedMTU = getBleDefaultMtu();
    }

    // Ensure MTU is large enough for at least 1 byte of payload per packet
    if (this._negotiatedMTU < BLE_CONSTANTS.MIN_USABLE_MTU) {
      const defaultMtu = getBleDefaultMtu();
      this.log(`[BLE] Negotiated MTU (${this._negotiatedMTU}) is below minimum (${BLE_CONSTANTS.MIN_USABLE_MTU}), falling back to DEFAULT_MTU (${defaultMtu})`);
      this._negotiatedMTU = defaultMtu;
    }
  }

  /**
   * @brief Handle an unexpected or user-initiated disconnection.
   *
   * Resets characteristic references and MTU. If the disconnect was
   * user-initiated, transitions to "disconnected". Otherwise, attempts
   * automatic reconnection up to the configured max reconnect attempts.
   */
  private handleDisconnect(): void {
    this.log(`[BLE] ${l10n.t('Device disconnected: {0}', this.deviceName)}`);

    this.removeConsoleListener();
    this.programCharacteristic = null;
    this.consoleCharacteristic = null;
    this.negotiatedMtuCharacteristic = null;
    this._negotiatedMTU = getBleDefaultMtu();

    if (this.userInitiatedDisconnect) {
      this.userInitiatedDisconnect = false;
      this.reconnectAttempts = 0;
      this.currentDevice = null;
      this.setConnectionState('disconnected');
      return;
    }

    if (this.reconnectAttempts < getBleMaxReconnectAttempts()) {
      this.attemptReconnect();
    } else {
      this.log(`[BLE] ${l10n.t('Max reconnection attempts reached')}`);
      this.currentDevice = null;
      this.reconnectAttempts = 0;
      this.setConnectionState('disconnected');
    }
  }

  /**
   * @brief Schedule an automatic reconnection attempt with exponential back-off.
   *
   * Delay doubles with each successive attempt. Gives up after
   * the configured max reconnect attempts.
   */
  private attemptReconnect(): void {
    this.reconnectAttempts++;
    const delay = getBleInitialReconnectDelay() * Math.pow(2, this.reconnectAttempts - 1);
    this.setConnectionState('reconnecting');
    this.log(`[BLE] ${l10n.t('Reconnecting ({0}/{1})...', String(this.reconnectAttempts), String(getBleMaxReconnectAttempts()))}`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.userInitiatedDisconnect || !this.currentDevice) { return; }

      try {
        await this.connectToDevice(this.currentDevice);
        this.reconnectAttempts = 0;
        this.log(`[BLE] ${l10n.t('Reconnected successfully')}`);
      } catch {
        if (this.reconnectAttempts < getBleMaxReconnectAttempts()) {
          this.attemptReconnect();
        } else {
          this.log(`[BLE] ${l10n.t('Max reconnection attempts reached')}`);
          this.currentDevice = null;
          this.reconnectAttempts = 0;
          this.setConnectionState('disconnected');
        }
      }
    }, delay);
  }

  /**
   * @brief Gracefully disconnect from the current device.
   *
   * Sets the user-initiated flag to suppress auto-reconnect, disconnects
   * the peripheral, and resets all internal state.
   */
  async disconnect(): Promise<void> {
    this.userInitiatedDisconnect = true;
    this.reconnectAttempts = getBleMaxReconnectAttempts();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.currentDevice) {
      this.log(`[BLE] ${l10n.t('Disconnecting from device...')}`);
      try {
        // disconnectAsync triggers the 'disconnect' event which calls handleDisconnect.
        // handleDisconnect checks userInitiatedDisconnect and performs cleanup + state transition.
        await this.currentDevice.disconnectAsync();
      } catch { /* ignore */ }
    }

    // Ensure cleanup even if disconnectAsync did not fire the event
    if (this._connectionState !== 'disconnected') {
      this.removeConsoleListener();
      this.programCharacteristic = null;
      this.consoleCharacteristic = null;
      this.negotiatedMtuCharacteristic = null;
      this.currentDevice = null;
      this._negotiatedMTU = getBleDefaultMtu();
      this.reconnectAttempts = 0;
      this.setConnectionState('disconnected');
    }
    this.log(`[BLE] ${l10n.t('Disconnected from device')}`);
  }

  /**
   * @brief Remove the console data listener from the current console characteristic.
   */
  private removeConsoleListener(): void {
    if (this.consoleCharacteristic && this.consoleDataHandler) {
      this.consoleCharacteristic.removeListener('data', this.consoleDataHandler);
      this.consoleDataHandler = null;
    }
  }

  /**
   * @brief Remove the Noble 'discover' listener registered by this manager.
   */
  private removeDiscoverListener(): void {
    if (this.discoverHandler) {
      getNoble().removeListener('discover', this.discoverHandler);
      this.discoverHandler = null;
    }
  }

  /**
   * @brief Dispose all resources held by this manager.
   *
   * Cancels pending reconnect and scan timers, disconnects the device
   * (best-effort), removes Noble listeners, and disposes every event
   * emitter.  Called automatically when the extension deactivates.
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    this.userInitiatedDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.removeDiscoverListener();
    this.removeConsoleListener();
    // Best-effort BLE disconnect
    if (this.currentDevice) {
      try { await this.currentDevice.disconnectAsync(); } catch { /* ignore */ }
      this.currentDevice = null;
    }
    this._onConnectionStateChanged.dispose();
    this._onConsoleOutput.dispose();
    this._onLog.dispose();
    this._onScanningStateChanged.dispose();
    this._onDeviceDiscovered.dispose();
  }
}
