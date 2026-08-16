/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import { BleManager } from './ble-manager';
import * as ui from './ui-manager';

/** @brief globalState key for persisted saved-device list. */
export const SAVED_DEVICES_KEY = 'openblink.savedDevices';

/**
 * @brief Shared mutable state for the extension host.
 *
 * Aggregates the singletons and settings that were previously module-level
 * `let` variables in `extension.ts`, so they can be shared between the
 * activation wiring, the build pipeline, command registration, and the MCP
 * command handlers without circular imports.
 */
export class ExtensionState {
  /** @brief Singleton BLE manager instance. */
  bleManager!: BleManager;
  /** @brief Sidebar tree-view provider for BLE device scanning and selection. */
  devicesProvider!: ui.DevicesTreeProvider;
  /** @brief Sidebar tree-view provider for user actions. */
  tasksProvider!: ui.TasksTreeProvider;
  /** @brief Sidebar tree-view provider for connected device information. */
  deviceInfoProvider!: ui.DeviceInfoTreeProvider;
  /** @brief Sidebar tree-view provider for build/transfer metrics. */
  metricsProvider!: ui.MetricsTreeProvider;
  /** @brief Sidebar tree-view provider for selected board's API reference. */
  boardReferenceProvider!: ui.BoardReferenceTreeProvider;
  /** @brief Sidebar tree-view provider for MCP integration status. */
  mcpStatusProvider!: ui.McpStatusTreeProvider;
  /** @brief Workspace-relative path of the Ruby source file to compile. */
  currentSourceFile = 'app.rb';
  /** @brief Active program slot on the target device (1 or 2). */
  currentSlot = 2;
  /** @brief Guard flag to prevent overlapping build-and-blink operations. */
  isBuilding = false;
  /** @brief URIs of files being saved manually (not by auto-save). */
  readonly pendingManualSave = new Set<string>();
}
