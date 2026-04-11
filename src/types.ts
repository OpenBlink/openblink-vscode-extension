/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import type { Peripheral, Service, Characteristic, Descriptor } from '@abandonware/noble';

// ============================================================================
// BLE Types
// ============================================================================

/** @brief Represents the current BLE connection state. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * @brief Information about a discovered BLE device.
 */
export interface DeviceInfo {
  /** @brief Advertised local name of the device. */
  name: string;
  /** @brief Unique peripheral identifier. */
  id: string;
  /** @brief Reference to the underlying Noble peripheral object. */
  peripheral: NoblePeripheral;
}

/**
 * @brief Extended Noble Peripheral type with async helper methods.
 *
 * Overrides `discoverServicesAsync` to return {@link NobleService} instances
 * and adds `connectAsync`, `disconnectAsync`, `updateRssiAsync`, and optional
 * `gatt.requestMTU` for MTU negotiation.
 */
export type NoblePeripheral = Omit<Peripheral, 'discoverServicesAsync'> & {
  discoverServicesAsync: () => Promise<NobleService[]>;
  connectAsync: () => Promise<void>;
  disconnectAsync: () => Promise<void>;
  updateRssiAsync: () => Promise<number>;
  gatt?: {
    requestMTU: (mtu: number) => Promise<number>;
  };
};

/**
 * @brief Extended Noble Service type with async characteristic discovery.
 */
export type NobleService = Service & {
  uuid: string;
  characteristics: Characteristic[];
  getCharacteristicAsync: (uuid: string) => Promise<Characteristic>;
  discoverCharacteristicsAsync: (characteristicUUIDs?: string[]) => Promise<Characteristic[]>;
};

/**
 * @brief Extended Noble Characteristic type with async read/write and subscription.
 */
export type NobleCharacteristic = Characteristic & {
  subscribeAsync: () => Promise<void>;
  unsubscribeAsync: () => Promise<void>;
  readAsync: () => Promise<Buffer>;
  writeAsync: (data: Buffer | ArrayBuffer, withoutResponse?: boolean) => Promise<void>;
  discoverDescriptorsAsync: () => Promise<Descriptor[]>;
  on: (event: string, callback: (data: Buffer, isNotification?: boolean) => void) => void;
};

// ============================================================================
// Compiler Types
// ============================================================================

/**
 * @brief Result returned from the mruby bytecode compiler.
 */
export interface CompileResult {
  /** @brief Whether compilation succeeded. */
  success: boolean;
  /** @brief Compiled mruby bytecode (.mrb). Present only on success. */
  bytecode?: Uint8Array;
  /** @brief Human-readable error message. Present only on failure. */
  error?: string;
  /** @brief Compilation wall-clock time in milliseconds. */
  compileTime: number;
  /** @brief Size of the compiled bytecode in bytes (0 on failure). */
  size: number;
}

/**
 * @brief Emscripten module interface exposing the mrbc WASM binary.
 *
 * Provides low-level memory management (`_malloc`, `_free`, `setValue`),
 * string conversion (`stringToUTF8`), the compiler entry point (`_main`),
 * and a virtual filesystem (`FS`) for temporary file I/O.
 */
export interface EmscriptenModule {
  _main: (argc: number, argv: number) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  stringToUTF8: (str: string, outPtr: number, maxBytesToWrite: number) => void;
  setValue: (ptr: number, value: number, type: string) => void;
  /** @brief Emscripten virtual filesystem API. */
  FS: {
    writeFile: (name: string, data: string | Uint8Array) => void;
    readFile: (name: string) => Uint8Array;
    unlink: (name: string) => void;
    analyzePath: (name: string) => { exists: boolean };
    stat: (name: string) => { size: number };
  };
}

/**
 * @brief Factory function type that instantiates the mrbc Emscripten module.
 *
 * Accepts optional `wasmBinary`, `print`, and `printErr` callbacks,
 * and returns a promise that resolves to the initialized {@link EmscriptenModule}.
 */
export type CreateMrbcFactory = (options: {
  wasmBinary?: ArrayBuffer;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}) => Promise<EmscriptenModule>;

// ============================================================================
// Board Types
// ============================================================================

/**
 * @brief Static board configuration loaded from `config.json`.
 */
export interface BoardConfig {
  /** @brief Internal board identifier (e.g. "m5stamps3"). */
  name: string;
  /** @brief Human-readable board name shown in the UI. */
  displayName: string;
  /** @brief Board manufacturer name. */
  manufacturer: string;
  /** @brief Short description of the board. */
  description: string;
}

/**
 * @brief Runtime board object that extends {@link BoardConfig} with
 *        loaded sample code and the filesystem path to board resources.
 */
export interface Board extends BoardConfig {
  /** @brief Sample Ruby source code bundled with the board. */
  sampleCode: string;
  /** @brief Absolute filesystem path to the board resource directory. */
  referencePath: string;
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * @brief Metrics collected from a single build-and-transfer cycle.
 */
export interface MetricsData {
  /** @brief Compilation time in milliseconds. */
  compileTime?: number;
  /** @brief BLE transfer time in milliseconds. */
  transferTime?: number;
  /** @brief Compiled program size in bytes. */
  programSize?: number;
}

/**
 * @brief Aggregate statistics (min / avg / max) for a metrics series.
 */
export interface MetricsStats {
  min: number | null;
  avg: number | null;
  max: number | null;
}

/**
 * @brief Rolling history of metrics values, capped at a fixed maximum length.
 */
export interface MetricsHistory {
  /** @brief History of compilation times (ms). */
  compile: number[];
  /** @brief History of transfer times (ms). */
  transfer: number[];
  /** @brief History of program sizes (bytes). */
  size: number[];
}

// ============================================================================
// Saved Device Types
// ============================================================================

/**
 * @brief Serializable record of a previously connected device.
 *
 * Stored in `globalState` so the user can reconnect without re-scanning.
 */
export interface SavedDevice {
  /** @brief Advertised local name at the time of connection. */
  name: string;
  /** @brief Noble peripheral identifier (platform-specific). */
  id: string;
}

// ============================================================================
// Protocol Constants
// ============================================================================

/**
 * @brief BLE protocol constants used across the extension.
 *
 * Contains UUIDs for the OpenBlink GATT service and characteristics,
 * default/requested MTU sizes, packet header sizes, connection and
 * discovery timeouts, and safety limits ({@link MIN_USABLE_MTU}).
 */
export const BLE_CONSTANTS = {
  OPENBLINK_SERVICE_UUID: '227da52ce13a412bbefbba2256bb7fbe',
  OPENBLINK_PROGRAM_CHARACTERISTIC_UUID: 'ad9fdd5611354a84923cce5a244385e7',
  OPENBLINK_CONSOLE_CHARACTERISTIC_UUID: 'a015b3de185a4252aa047a87d38ce148',
  OPENBLINK_MTU_CHARACTERISTIC_UUID: 'ca1411513113448bb21a6a6203d253ff',

  DEFAULT_MTU: 20,
  REQUESTED_MTU: 512,
  DATA_HEADER_SIZE: 6,
  PROGRAM_HEADER_SIZE: 8,
  MAX_RECONNECT_ATTEMPTS: 5,
  INITIAL_RECONNECT_DELAY: 1000,
  WRITE_TIMEOUT: 10000,
  SCAN_TIMEOUT: 10000,
  CONNECTION_TIMEOUT: 10000,
  CHARACTERISTIC_DISCOVERY_TIMEOUT: 5000,
  BLUETOOTH_INIT_TIMEOUT: 15000,
  SCAN_GRACE_PERIOD: 2000,
  DISCOVERY_POLL_INTERVAL: 200,
  /** @brief Minimum usable MTU (DATA_HEADER_SIZE + 1) to guarantee at least 1 byte of payload. */
  MIN_USABLE_MTU: 7,
};
