/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { Board, BoardConfig } from './types';

/** @brief List of supported board directory names under `resources/boards/`. */
/** @note Generic board is listed first as it serves as the default board. */
const BOARD_LIST = ['generic', 'm5stamps3', 'xiao-nrf54l15'];

/** @brief All loaded board definitions. Populated by {@link loadBoards}. */
let boards: Board[] = [];
/** @brief Currently selected board. Persisted in workspace configuration. */
let currentBoard: Board | null = null;

/**
 * @brief Load board definitions from the extension's bundled resources.
 *
 * Reads `config.json` and optional `sample.rb` for each board listed in
 * {@link BOARD_LIST}. If no board has been selected yet, restores the
 * previous selection from the `openblink.board` workspace setting.
 * If no saved setting is found, defaults to the Generic board which provides
 * mruby/c release3.4.1 standard library functions.
 *
 * @param extensionUri  Base URI of the installed extension.
 * @returns Array of loaded {@link Board} objects.
 */
export function loadBoards(extensionUri: vscode.Uri): Board[] {
  boards = [];
  const boardsDir = vscode.Uri.joinPath(extensionUri, 'out', 'boards').fsPath;

  for (const boardName of BOARD_LIST) {
    const configPath = path.join(boardsDir, boardName, 'config.json');
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const config: BoardConfig = JSON.parse(configRaw);

      // Runtime validation: skip boards with missing required fields
      if (typeof config.name !== 'string' || !config.name ||
          typeof config.displayName !== 'string' || !config.displayName ||
          typeof config.manufacturer !== 'string' ||
          typeof config.description !== 'string') {
        continue;
      }

      const samplePath = path.join(boardsDir, boardName, 'sample.rb');
      let sampleCode = '';
      try { sampleCode = fs.readFileSync(samplePath, 'utf-8'); } catch { /* ok */ }

      boards.push({
        ...config,
        sampleCode,
        referencePath: path.join(boardsDir, boardName),
      });
    } catch {
      // Board config not found or invalid JSON, skip
    }
  }

  if (boards.length > 0 && !currentBoard) {
    const inspected = vscode.workspace.getConfiguration('openblink').inspect<string>('board');
    const savedBoard = inspected?.globalValue ?? inspected?.workspaceValue ?? inspected?.workspaceFolderValue;
    currentBoard = (savedBoard ? boards.find(b => b.name === savedBoard) : undefined) ?? boards.find(b => b.name === 'generic') ?? null;
  }

  return boards;
}

/**
 * @brief Get all loaded board definitions.
 * @returns Array of {@link Board} objects.
 */
export function getBoards(): Board[] { return boards; }

/**
 * @brief Get the currently selected board.
 * @returns The active {@link Board}, or null if none is selected.
 */
export function getCurrentBoard(): Board | null { return currentBoard; }

/**
 * @brief Set the currently selected board.
 *
 * Used when the `openblink.board` configuration is changed externally
 * (e.g. via the Settings UI) to keep internal state in sync.
 *
 * @param board  The board to set as current.
 */
export function setCurrentBoard(board: Board): void { currentBoard = board; }

/**
 * @brief Show a QuickPick UI to let the user select a target board.
 *
 * Updates the `openblink.board` global setting on selection.
 *
 * @returns The selected {@link Board}, or undefined if cancelled.
 */
export async function selectBoard(): Promise<Board | undefined> {
  const items = boards.map(b => ({
    label: b.displayName,
    description: `${b.manufacturer} — ${b.description}`,
    board: b,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: l10n.t('Select a board'),
  });

  if (selected) {
    currentBoard = selected.board;
    await vscode.workspace.getConfiguration('openblink').update('board', currentBoard.name, vscode.ConfigurationTarget.Global);
    return currentBoard;
  }
  return undefined;
}

/**
 * @brief Resolve the filesystem path to a board's reference documentation.
 *
 * Looks for a localized Markdown file (e.g. `reference.ja.md`) matching
 * the current VS Code display language. Falls back to `reference.md`.
 *
 * @param board  Target board whose reference path to resolve.
 * @returns Absolute path to the reference Markdown file.
 */
export function getLocalizedReferencePath(board: Board): string {
  const lang = vscode.env.language;
  const boardDir = board.referencePath;

  // Try localized version first
  const localizedSuffix = lang === 'ja' ? '.ja' : lang.startsWith('zh') ? `.${lang}` : '';
  if (localizedSuffix) {
    const localizedPath = path.join(boardDir, `reference${localizedSuffix}.md`);
    if (fs.existsSync(localizedPath)) {
      return localizedPath;
    }
  }

  // Fallback to English
  return path.join(boardDir, 'reference.md');
}
