/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

/**
 * @brief Extract a human-readable error message from any thrown value.
 *
 * This module is intentionally dependency-free so it can be shared between
 * the extension bundle and the standalone MCP server bundle.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
