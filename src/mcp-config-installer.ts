/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as ui from './ui-manager';
import * as mcpBridge from './mcp-bridge';
import { errorMessage } from './error-utils';

export function buildMcpServerEntry(context: vscode.ExtensionContext, ipcDir: string): {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const mcpServerPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
  return {
    type: 'stdio',
    command: 'node',
    args: [mcpServerPath],
    env: {
      OPENBLINK_IPC_DIR: ipcDir,
      OPENBLINK_EXTENSION_DIR: context.extensionUri.fsPath,
    },
  };
}

/**
 * @brief Install the OpenBlink MCP server into `.vscode/mcp.json`.
 *
 * Creates the file if it does not exist. If it already contains other
 * servers, they are preserved; only the `openblink` entry is added or
 * overwritten. This mirrors the behaviour VS Code 1.106+ expects for
 * workspace-level MCP configuration.
 *
 * @param context  The extension context.
 */
export async function installMcpToWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const ipcDir = mcpBridge.resolveIpcDir(context);
  if (!ipcDir) {
    vscode.window.showErrorMessage(
      l10n.t('Cannot generate MCP configuration: no workspace is open. Please open a folder first.'),
    );
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      l10n.t('Cannot generate MCP configuration: no workspace is open. Please open a folder first.'),
    );
    return;
  }

  const mcpConfigUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'mcp.json');
  const newEntry = buildMcpServerEntry(context, ipcDir);

  // Try to read the existing mcp.json to preserve other server entries.
  // Uses a permissive shape (Record<string, unknown>) because the file is
  // user-editable and may contain arbitrary fields we do not own.
  let existingConfig: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = await vscode.workspace.fs.readFile(mcpConfigUri);
    existed = true;
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existingConfig = parsed as Record<string, unknown>;
    }
  } catch {
    // File does not exist or is unparseable — treat as empty.
  }

  // If the file exists and already has an openblink entry, confirm overwrite
  // to avoid silently clobbering user-customised settings.
  const existingServers = existingConfig.servers;
  const hasExisting = existed
    && existingServers
    && typeof existingServers === 'object'
    && !Array.isArray(existingServers)
    && (existingServers as Record<string, unknown>)['openblink'] !== undefined;

  if (hasExisting) {
    const overwrite = l10n.t('Overwrite');
    const cancel = l10n.t('Cancel');
    const choice = await vscode.window.showWarningMessage(
      l10n.t('The \'openblink\' entry already exists in .vscode/mcp.json. Overwrite?'),
      { modal: true },
      overwrite,
      cancel,
    );
    if (choice !== overwrite) { return; }
  }

  // Merge: preserve other servers, overwrite/add openblink.
  const mergedServers: Record<string, unknown> = (existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers))
    ? { ...(existingServers as Record<string, unknown>) }
    : {};
  mergedServers['openblink'] = newEntry;

  const merged: Record<string, unknown> = { ...existingConfig, servers: mergedServers };
  const content = JSON.stringify(merged, null, 2) + '\n';

  try {
    // Ensure the .vscode directory exists before writing.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.vscode'));
    await vscode.workspace.fs.writeFile(mcpConfigUri, new TextEncoder().encode(content));
    ui.log(`[MCP] Wrote workspace configuration to ${mcpConfigUri.fsPath}`);
    vscode.window.showInformationMessage(
      l10n.t('OpenBlink MCP server installed to .vscode/mcp.json'),
    );
    // Open the file so the user can verify the result.
    const doc = await vscode.workspace.openTextDocument(mcpConfigUri);
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    const msg = errorMessage(error);
    ui.log(`[MCP] Failed to write workspace configuration: ${msg}`);
    vscode.window.showErrorMessage(
      l10n.t('Failed to write .vscode/mcp.json: {0}', msg),
    );
  }
}

/**
 * @brief Show a JSON snippet for non-VS Code IDEs (Windsurf/Cursor/Cline).
 *
 * Writes the `mcpServers`-style configuration into a new unsaved editor
 * document so the user can copy it into their IDE's MCP config file.
 *
 * @param context  The extension context.
 * @param ipcDir   Absolute IPC directory path.
 */
export async function showMcpConfigSnippet(context: vscode.ExtensionContext, ipcDir: string): Promise<void> {
  const entry = buildMcpServerEntry(context, ipcDir);
  // The snippet uses the legacy `mcpServers` key expected by Windsurf,
  // Cursor, and Cline.  The `type` field is omitted here because these
  // IDEs default to stdio transport.
  const { type: _type, ...entryWithoutType } = entry;
  void _type;
  const configSnippet = JSON.stringify({
    mcpServers: { openblink: entryWithoutType },
  }, null, 2);

  const doc = await vscode.workspace.openTextDocument({
    content: configSnippet,
    language: 'json',
  });
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    l10n.t('Copy this MCP server configuration to your IDE\'s MCP config file.'),
  );
}
