/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseDiagnostics } from '../../compiler';

/**
 * @brief Unit tests for {@link parseDiagnostics}.
 *
 * Validates parsing of mrbc compiler output (`filename:line:col: message`)
 * into VS Code diagnostics, including severity selection, 1-based to
 * 0-based position conversion, and rejection of non-matching lines.
 */
suite('Compiler Test Suite', () => {
  const uri = vscode.Uri.file('/tmp/test.rb');

  suite('parseDiagnostics', () => {
    test('should return no diagnostics for empty output', () => {
      assert.deepStrictEqual(parseDiagnostics('', uri), []);
    });

    test('should ignore lines that do not match the mrbc format', () => {
      const output = ['mrbc: something went wrong', 'random text', ''].join('\n');
      assert.deepStrictEqual(parseDiagnostics(output, uri), []);
    });

    test('should parse an error line with correct position and severity', () => {
      const diagnostics = parseDiagnostics('main.rb:3:7: syntax error, unexpected end', uri);
      assert.strictEqual(diagnostics.length, 1);
      const diag = diagnostics[0];
      assert.strictEqual(diag.message, 'syntax error, unexpected end');
      assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Error);
      // mrbc positions are 1-based; VS Code ranges are 0-based
      assert.strictEqual(diag.range.start.line, 2);
      assert.strictEqual(diag.range.start.character, 6);
      assert.strictEqual(diag.range.end.character, 7);
    });

    test('should classify warning messages as warnings', () => {
      const diagnostics = parseDiagnostics('main.rb:1:1: warning: shadowing outer variable', uri);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    test('should parse multiple diagnostic lines', () => {
      const output = [
        'main.rb:1:1: warning: something',
        'not a diagnostic',
        'main.rb:5:10: syntax error',
      ].join('\n');
      const diagnostics = parseDiagnostics(output, uri);
      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
      assert.strictEqual(diagnostics[1].severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(diagnostics[1].range.start.line, 4);
      assert.strictEqual(diagnostics[1].range.start.character, 9);
    });

    test('should clamp line and column to zero for 0-based inputs', () => {
      const diagnostics = parseDiagnostics('main.rb:0:0: strange position', uri);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].range.start.line, 0);
      assert.strictEqual(diagnostics[0].range.start.character, 0);
    });

    test('should trim whitespace around the message', () => {
      const diagnostics = parseDiagnostics('main.rb:2:3:    padded message   ', uri);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].message, 'padded message');
    });
  });
});
