/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import { EventEmitter } from 'vscode';
import * as l10n from '@vscode/l10n';
import type { Peripheral } from '@abandonware/noble';
import {
  ConnectionState,
  DeviceInfo,
  NoblePeripheral,
  NobleCharacteristic,
  BLE_CONSTANTS,
  getBleScanTimeout,
  getBleConnectionTimeout,
  getBleMaxReconnectAttempts,
  getBleInitialReconnectDelay,
  getBleDefaultMtu,
  getBleHeartbeatInterval,
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

/**
 * @brief Internal connection lifecycle phase.
 *
 * Extends the public {@link ConnectionState} with `transferring` (a
 * sub-state of `connected` during firmware transfer) and `disposed`.
 */
type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'transferring'
  | 'reconnecting'
  | 'disposed';

/**
 * @brief Allowed connection phase transitions.
 *
 * Any transition not listed here is rejected (and logged), structurally
 * preventing conflicting operations such as starting a transfer while
 * disconnected or reviving a disposed manager.
 */
const CONNECTION_TRANSITIONS: Record<ConnectionPhase, readonly ConnectionPhase[]> = {
  disconnected: ['connecting', 'disposed'],
  connecting: ['connected', 'reconnecting', 'disconnected', 'disposed'],
  connected: ['transferring', 'reconnecting', 'disconnected', 'disposed'],
  transferring: ['connected', 'reconnecting', 'disconnected', 'disposed'],
  reconnecting: ['connecting', 'connected', 'reconnecting', 'disconnected', 'disposed'],
  disposed: [],
};

/**
 * @brief Map an internal connection phase to the public {@link ConnectionState}.
 *
 * `transferring` is reported as `connected`; `disposed` as `disconnected`.
 */
function toPublicState(phase: ConnectionPhase): ConnectionState {
  switch (phase) {
    case 'connecting': return 'connecting';
    case 'connected':
    case 'transferring': return 'connected';
    case 'reconnecting': return 'reconnecting';
    default: return 'disconnected';
  }
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
  /** @brief Heartbeat timer for BLE keep-alive. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** @brief Currently connected peripheral, or null if disconnected. */
  private currentDevice: NoblePeripheral | null = null;
  /** @brief Current connection lifecycle phase (internal state machine). */
  private phase: ConnectionPhase = 'disconnected';
  /** @brief Number of reconnection attempts performed so far. */
  private reconnectAttempts = 0;
  /** @brief Flag to suppress auto-reconnect after a user-initiated disconnect. */
  private userInitiatedDisconnect = false;
  /** @brief Effective MTU for data payloads. */
  private _negotiatedMTU = getBleDefaultMtu();
  /** @brief Bound handler for console data events, stored for proper removal. */
  private consoleDataHandler: ((data: Buffer) => void) | null = null;
  /** @brief Handle for the pending reconnect timer, if any. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * @brief Monotonic counter identifying the current connection attempt.
   *
   * Each connect/disconnect bumps the epoch; an in-flight connectToDevice
   * aborts when its captured epoch no longer matches, so a stale reconnect
   * callback cannot race with a newer user-initiated connection.
   */
  private connectionEpoch = 0;
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
  get connectionState(): ConnectionState { return toPublicState(this.phase); }
  /** @brief Negotiated BLE MTU size in bytes. */
  get negotiatedMTU(): number { return this._negotiatedMTU; }
  /** @brief Enter/leave the transferring phase to pause heartbeat during firmware transfer. */
  set isTransferring(value: boolean) {
    if (value) {
      this.transition('transferring');
    } else if (this.phase === 'transferring') {
      this.transition('connected');
    }
  }
  /** @brief Whether a device is currently connected and ready. */
  get isConnected(): boolean {
    return (this.phase === 'connected' || this.phase === 'transferring') && this.currentDevice !== null;
  }
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
   * @brief Attempt a connection phase transition.
   *
   * Transitions not allowed by {@link CONNECTION_TRANSITIONS} are rejected
   * and logged. Listeners are notified only when the *public* connection
   * state actually changes (e.g. `connected` -> `transferring` is silent).
   *
   * @param to  Target phase.
   * @returns   `true` if the transition was applied (or was a no-op).
   */
  private transition(to: ConnectionPhase): boolean {
    if (this.phase === to) { return true; }
    if (!CONNECTION_TRANSITIONS[this.phase].includes(to)) {
      this.log(`[BLE] Ignored invalid state transition: ${this.phase} -> ${to}`);
      return false;
    }
    const previousPublic = toPublicState(this.phase);
    this.phase = to;
    if (to === 'disposed') { return true; }
    const nextPublic = toPublicState(to);
    if (previousPublic !== nextPublic) {
      this._onConnectionStateChanged.fire(nextPublic);
    }
    return true;
  }

  /**
   * @brief Release all connection-scoped resources.
   *
   * Centralises the cleanup previously duplicated across connect failure,
   * disconnect handling, and disposal: removes the console listener, drops
   * characteristic references, and resets the negotiated MTU.
   *
   * @param clearDevice  Also drop the current peripheral reference.
   */
  private cleanupConnection(clearDevice: boolean): void {
    this.removeConsoleListener();
    this.programCharacteristic = null;
    this.consoleCharacteristic = null;
    this.negotiatedMtuCharacteristic = null;
    this._negotiatedMTU = getBleDefaultMtu();
    if (clearDevice) {
      this.currentDevice = null;
    }
  }

  /**
   * @brief Emit an internal log message.
   * @param message  Log message text.
   */
  private log(message: string): void {
    if (this.phase === 'disposed') { return; }
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
   * @brief Wait for the current scan to complete, event-driven.
   *
   * Resolves when scanning stops (auto-timeout or {@link stopScan}), when
   * the optional target device is discovered, or when the optional timeout
   * elapses — whichever comes first. Resolves immediately if no scan is
   * active or the target device is already discovered.
   *
   * @param options.deviceId   Resolve early once this device is discovered.
   * @param options.timeoutMs  Upper bound on the wait in milliseconds.
   */
  async waitForScanCompletion(options: { deviceId?: string; timeoutMs?: number } = {}): Promise<void> {
    if (!this._isScanning) { return; }
    if (options.deviceId !== undefined && this._discoveredDevices.has(options.deviceId)) { return; }

    await new Promise<void>((resolve) => {
      const disposables: { dispose(): void }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = () => {
        if (settled) { return; }
        settled = true;
        for (const d of disposables) { d.dispose(); }
        if (timer) { clearTimeout(timer); }
        resolve();
      };

      disposables.push(this.onScanningStateChanged((scanning) => {
        if (!scanning) { finish(); }
      }));
      if (options.deviceId !== undefined) {
        const targetId = options.deviceId;
        disposables.push(this.onDeviceDiscovered((info) => {
          if (info.id === targetId) { finish(); }
        }));
      }
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(finish, options.timeoutMs);
      }

      // Guard against the scan having stopped between the check above and
      // listener registration.
      if (!this._isScanning) { finish(); }
    });
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
    if (this.phase === 'connecting' || !this.transition('connecting')) {
      return;
    }
    // Cancel any pending auto-reconnect so it cannot race with this
    // user-initiated connection attempt.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const epoch = ++this.connectionEpoch;
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

      await this.connectToDevice(info.peripheral, epoch);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`[BLE] Error: ${msg}`);
      // Clean up BLE connection to prevent resource leaks when post-connect setup fails
      if (this.currentDevice) {
        try { await this.currentDevice.disconnectAsync(); } catch { /* ignore */ }
      }
      this.cleanupConnection(true);
      this.transition('disconnected');
      throw error;
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
  private async connectToDevice(device: NoblePeripheral, epoch: number): Promise<void> {
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
    if (epoch !== this.connectionEpoch) {
      // A newer connection attempt superseded this one while awaiting.
      try { await device.disconnectAsync(); } catch { /* ignore */ }
      throw new Error(l10n.t('Connection attempt superseded'));
    }
    this.currentDevice = device;

    // Register disconnect handler immediately to avoid missing events during setup
    const disconnectHandler = () => this.handleDisconnect();
    device.once('disconnect', disconnectHandler);

    try {
      // Discover services and characteristics in one call
      const { characteristics } = await device.discoverSomeServicesAndCharacteristicsAsync(
        [BLE_CONSTANTS.OPENBLINK_SERVICE_UUID],
        [
          BLE_CONSTANTS.OPENBLINK_CONSOLE_CHARACTERISTIC_UUID,
          BLE_CONSTANTS.OPENBLINK_PROGRAM_CHARACTERISTIC_UUID,
          BLE_CONSTANTS.OPENBLINK_MTU_CHARACTERISTIC_UUID,
        ]
      );

      this.consoleCharacteristic =
        (characteristics.find(
          (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_CONSOLE_CHARACTERISTIC_UUID
        ) as NobleCharacteristic | undefined) ?? null;

      this.programCharacteristic =
        (characteristics.find(
          (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_PROGRAM_CHARACTERISTIC_UUID
        ) as NobleCharacteristic | undefined) ?? null;

      this.negotiatedMtuCharacteristic =
        (characteristics.find(
          (c) => c.uuid.replace(/-/g, '') === BLE_CONSTANTS.OPENBLINK_MTU_CHARACTERISTIC_UUID
        ) as NobleCharacteristic | undefined) ?? null;

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

      if (epoch !== this.connectionEpoch) {
        throw new Error(l10n.t('Connection attempt superseded'));
      }
      this.transition('connected');
      this.log(`[BLE] ${l10n.t('Connected to device: {0}', device.advertisement?.localName ?? 'Unknown')}`);

      // Start keep-alive heartbeat
      this.startKeepAlive();
    } catch (error) {
      // Remove disconnect listener on setup failure to prevent handleDisconnect from running
      device.removeListener('disconnect', disconnectHandler);
      throw error;
    }
  }

  /**
   * @brief Negotiate the BLE MTU with the connected device.
   *
   * Uses Noble's standard `peripheral.mtu` (auto-negotiated on Linux) first.
   * Falls back to reading the device's advertised MTU from the dedicated
   * characteristic (Mac/Win where peripheral.mtu is null). On failure,
   * resets to the configured default MTU.
   *
   * The final value is clamped to at least MIN_USABLE_MTU
   * to guarantee that data packets always carry at least one payload byte.
   *
   * @param device  The connected Noble peripheral.
   */
  private async negotiateMTU(device: NoblePeripheral): Promise<void> {
    try {
      // 1. Noble standard: peripheral.mtu (Linux hci-socket auto-negotiates to 256)
      if (device.mtu !== null && device.mtu > 0) {
        this._negotiatedMTU = device.mtu - 3; // ATT_MTU - 3 (opcode + handle)
      // 2. Fallback: read device-side MTU from characteristic (Mac/Win)
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
   * @brief Send a heartbeat ping to keep the BLE connection alive.
   *
   * Reads from the MTU characteristic to maintain communication
   * and prevent the BLE supervision timeout from expiring.
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.phase !== 'connected') {
      return;
    }
    if (this.currentDevice?.state !== 'connected') {
      return;
    }
    if (!this.negotiatedMtuCharacteristic) {
      return;
    }
    try {
      await this.negotiatedMtuCharacteristic.readAsync();
    } catch (error) {
      this.log(`[BLE] Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @brief Start the keep-alive heartbeat timer.
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    const interval = getBleHeartbeatInterval();
    if (interval <= 0) {
      return; // 0 = disabled
    }
    this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, interval);
  }

  /**
   * @brief Stop the keep-alive heartbeat timer.
   */
  private stopKeepAlive(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
    // Prevent duplicate execution if already disconnected or reconnecting
    if (this.phase === 'disconnected' || this.phase === 'reconnecting' || this.phase === 'disposed') {
      return;
    }
    this.stopKeepAlive();
    this.log(`[BLE] ${l10n.t('Device disconnected: {0}', this.deviceName)}`);

    this.cleanupConnection(false);

    if (this.userInitiatedDisconnect) {
      this.userInitiatedDisconnect = false;
      this.reconnectAttempts = 0;
      this.currentDevice = null;
      this.transition('disconnected');
      return;
    }

    if (this.reconnectAttempts < getBleMaxReconnectAttempts()) {
      this.attemptReconnect();
    } else {
      this.log(`[BLE] ${l10n.t('Max reconnection attempts reached')}`);
      this.currentDevice = null;
      this.reconnectAttempts = 0;
      this.transition('disconnected');
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
    this.transition('reconnecting');
    this.log(`[BLE] ${l10n.t('Reconnecting ({0}/{1})...', String(this.reconnectAttempts), String(getBleMaxReconnectAttempts()))}`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Abort when a user-initiated connect/disconnect took over while this
      // callback was pending in the event loop (the timer can fire before
      // connectById gets a chance to clear it).
      if (this.userInitiatedDisconnect || !this.currentDevice || this.phase !== 'reconnecting') { return; }
      const epoch = ++this.connectionEpoch;

      try {
        await this.connectToDevice(this.currentDevice, epoch);
        this.reconnectAttempts = 0;
        this.log(`[BLE] ${l10n.t('Reconnected successfully')}`);
      } catch {
        // Clean up any partial BLE connection to avoid half-connected Noble state
        if (this.currentDevice) {
          try { await this.currentDevice.disconnectAsync(); } catch { /* ignore */ }
        }
        if (this.reconnectAttempts < getBleMaxReconnectAttempts()) {
          this.attemptReconnect();
        } else {
          this.log(`[BLE] ${l10n.t('Max reconnection attempts reached')}`);
          this.currentDevice = null;
          this.reconnectAttempts = 0;
          this.transition('disconnected');
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
    this.stopKeepAlive();
    this.connectionEpoch++;
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
    if (this.phase !== 'disconnected' && this.phase !== 'disposed') {
      this.cleanupConnection(true);
      this.reconnectAttempts = 0;
      this.transition('disconnected');
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
    this.stopKeepAlive();
    this.transition('disposed');
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
