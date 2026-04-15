/*
 * SPDX-License-Identifier: BSD-3-Clause
 * SPDX-FileCopyrightText: Copyright (c) 2026 OpenBlink All Rights Reserved.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { CompileResult, CreateMrbcFactory, EmscriptenModule } from './types';

declare const __non_webpack_require__: typeof require | undefined;

/** @brief Cached Emscripten module instance. Initialized lazily on first compile. */
let mrbcModule: EmscriptenModule | null = null;

/** @brief Promise that resolves when the compiler is initialized. */
let compilerInitPromise: Promise<void> | null = null;

/** @brief Extension URI for lazy initialization. */
let extensionUri: vscode.Uri | null = null;

/** @brief Dynamic callback for capturing mrbc stdout during compilation. */
let activePrintCallback: ((text: string) => void) | null = null;
/** @brief Dynamic callback for capturing mrbc stderr during compilation. */
let activePrintErrCallback: ((text: string) => void) | null = null;

/**
 * @brief Set the extension URI for later lazy initialization.
 * 
 * This should be called once during extension activation to enable
 * lazy loading of the WASM compiler.
 * 
 * @param uri  Base URI of the installed extension.
 */
export function setExtensionUri(uri: vscode.Uri): void {
  extensionUri = uri;
}

/**
 * @brief Initialize the mruby bytecode compiler lazily.
 *
 * Loads the `mrbc.js` and `mrbc.wasm` files from the extension's output
 * directory, instantiates the Emscripten module, and caches it for
 * subsequent calls to {@link compile}. Only initializes once.
 *
 * @returns Promise that resolves when initialization is complete.
 */
async function ensureCompilerInitialized(): Promise<void> {
  if (mrbcModule) {
    return; // Already initialized
  }
  
  if (compilerInitPromise) {
    return compilerInitPromise; // Initialization in progress
  }
  
  if (!extensionUri) {
    throw new Error('Extension URI not set. Call setExtensionUri() first.');
  }

  compilerInitPromise = (async () => {
    const mrbcJsPath = vscode.Uri.joinPath(extensionUri, 'out', 'mrbc.js').fsPath;
    const mrbcWasmPath = vscode.Uri.joinPath(extensionUri, 'out', 'mrbc.wasm').fsPath;

    const wasmBinary = fs.readFileSync(mrbcWasmPath);
    // Use __non_webpack_require__ to bypass webpack's static analysis for dynamic WASM module loading
    const dynamicRequire = typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : require;
    const createMrbc: CreateMrbcFactory = dynamicRequire(mrbcJsPath);

    mrbcModule = await createMrbc({
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength
      ),
      print: (text: string) => {
        if (activePrintCallback) { activePrintCallback(text); }
      },
      printErr: (text: string) => {
        if (activePrintErrCallback) { activePrintErrCallback(text); }
      },
    });
  })();

  return compilerInitPromise;
}

/**
 * @brief Initialize the mruby bytecode compiler (legacy synchronous version).
 *
 * @deprecated This function is kept for backward compatibility but no longer
 *             initializes the compiler. The compiler is now lazily loaded.
 * @param extensionUri  Base URI of the installed extension.
 */
export async function initCompiler(_extensionUri: vscode.Uri): Promise<void> {
  // Store the URI for lazy initialization
  setExtensionUri(_extensionUri);
  // Compiler will be initialized on first compile
}

/**
 * @brief Compile Ruby source code to mruby bytecode.
 *
 * Writes the source to the Emscripten virtual filesystem, invokes `mrbc`
 * via `_main`, reads back the resulting `.mrb` file, and returns a
 * {@link CompileResult}. Temporary files are cleaned up in a `finally` block.
 * The compiler is lazily initialized on first use.
 *
 * @param rubyCode  Ruby source code string.
 * @param onOutput  Optional callback for compiler stdout.
 * @param onError   Optional callback for compiler stderr.
 * @returns Compilation result including bytecode on success.
 */
export async function compile(
  rubyCode: string,
  onOutput?: (text: string) => void,
  onError?: (text: string) => void
): Promise<CompileResult> {
  // Ensure compiler is initialized before proceeding
  try {
    await ensureCompilerInitialized();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize compiler: ${msg}`,
      compileTime: 0,
      size: 0,
    };
  }

  if (!mrbcModule) {
    return {
      success: false,
      error: 'Compiler not initialized',
      compileTime: 0,
      size: 0,
    };
  }

  const inputFileName = 'temp_input.rb';
  const outputFileName = 'temp_output.mrb';

  activePrintCallback = onOutput ?? null;
  activePrintErrCallback = onError ?? null;

  mrbcModule.FS.writeFile(inputFileName, rubyCode);

  const args = ['mrbc', '-o', outputFileName, inputFileName];
  const argc = args.length;

  // Allocate argv array and individual argument strings in Emscripten heap
  let argv: number | null = null;
  const argPointers: number[] = [];

  try {
    argv = mrbcModule._malloc(argc * 4);
    for (const arg of args) {
      // UTF-8 can use up to 4 bytes per character + 1 for null terminator
      const bufSize = arg.length * 4 + 1;
      const ptr = mrbcModule._malloc(bufSize);
      mrbcModule.stringToUTF8(arg, ptr, bufSize);
      argPointers.push(ptr);
    }

    for (let i = 0; i < argPointers.length; i++) {
      mrbcModule.setValue(argv + i * 4, argPointers[i], 'i32');
    }

    const startTime = performance.now();
    // NOTE: Emscripten _main() is not designed for repeated invocations.
    // Static variables and atexit handlers may accumulate across calls.
    // mrbc is a simple CLI tool so this works in practice, but long-running
    // sessions may see gradual memory growth. Monitor if issues arise.
    const result = mrbcModule._main(argc, argv);
    const endTime = performance.now();
    const compileTime = endTime - startTime;

    if (result !== 0) {
      return {
        success: false,
        error: l10n.t('Compilation error: {0}', `exit code ${result}`),
        compileTime,
        size: 0,
      };
    }

    const mrbContent = mrbcModule.FS.readFile(outputFileName);

    return {
      success: true,
      bytecode: mrbContent,
      compileTime,
      size: mrbContent.length,
    };
  } finally {
    for (const ptr of argPointers) {
      if (ptr) { mrbcModule!._free(ptr); }
    }
    if (argv !== null) { mrbcModule!._free(argv); }

    // Reset dynamic callbacks
    activePrintCallback = null;
    activePrintErrCallback = null;

    // Cleanup temp files
    try { mrbcModule!.FS.unlink(inputFileName); } catch { /* ignore */ }
    try { mrbcModule!.FS.unlink(outputFileName); } catch { /* ignore */ }
  }
}

/**
 * @brief Parse mrbc compiler error output into VS Code diagnostics.
 *
 * Each line matching the pattern `filename:line:col: message` is converted
 * into a {@link vscode.Diagnostic} with the appropriate severity
 * (Warning or Error).
 *
 * @param errorOutput  Raw stderr output from the mrbc compiler.
 * @param documentUri  URI of the source document (used for range positioning).
 * @returns Array of VS Code diagnostic objects.
 */
export function parseDiagnostics(
  errorOutput: string,
  _documentUri: vscode.Uri
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const lines = errorOutput.split('\n');

  for (const line of lines) {
    // mrbc error format: "filename:line:col: message"
    const match = line.match(/^[^:]+:(\d+):(\d+):\s*(.+)$/);
    if (match) {
      const lineNum = Math.max(0, parseInt(match[1], 10) - 1);
      // mrbc columns are 1-indexed; VS Code Range columns are 0-indexed
      const colNum = Math.max(0, parseInt(match[2], 10) - 1);
      const message = match[3].trim();

      const range = new vscode.Range(lineNum, colNum, lineNum, colNum + 1);
      const severity = message.toLowerCase().includes('warning')
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Error;

      diagnostics.push(new vscode.Diagnostic(range, message, severity));
    }
  }

  return diagnostics;
}
