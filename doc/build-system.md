# Build System

This document describes how to build the OpenBlink VS Code extension, including the mrbc WASM compiler.

## Prerequisites

- Git (with submodule support)
- Node.js 18+
- Python 3 (required by Emscripten)
- Make
- Ruby (required by mruby build system)

## First-Time Setup

```bash
# Clone with submodules
git clone --recursive https://github.com/OpenBlink/openblink-vscode-extension.git
cd openblink-vscode-extension

# Or initialize submodules in an existing clone
git submodule update --init --recursive

# Install and activate Emscripten 5.0.5
make setup-emsdk

# Activate Emscripten in your shell
source vendor/emsdk/emsdk_env.sh
```

## Building mrbc WASM

```bash
# Activate Emscripten (if not already done in this shell)
source vendor/emsdk/emsdk_env.sh

# Build mrbc WASM (prerequisite checks run automatically)
make
```

The `make` command automatically verifies that `emcc`, `ruby`, and `rake` are available before building.

Output files:
- `resources/wasm/mrbc.js` — Emscripten MODULARIZE JS wrapper
- `resources/wasm/mrbc.wasm` — WebAssembly binary

## VS Code Extension Build

```bash
npm install
npm run compile    # webpack production build
npm run watch      # webpack dev watch mode
npm run package    # Create .vsix package
```

## Build Configuration

The mruby cross-compilation is configured in `mruby_build_config.rb`:

| Setting | Value | Purpose |
|---------|-------|---------|
| `ENVIRONMENT` | `node` | Target Node.js for VS Code extension |
| `MODULARIZE` | `1` | Export as factory function `createMrbc()` |
| `EXPORT_NAME` | `createMrbc` | CommonJS module export name |
| `EXPORT_ES6` | `0` | CommonJS format (not ES modules) |
| `FORCE_FILESYSTEM` | `1` | Enable MEMFS virtual filesystem |
| `INVOKE_RUN` | `0` | Don't auto-run main() |
| `WASM` | `1` | Output WebAssembly |
| `INITIAL_MEMORY` | 32MB | Initial memory allocation |
| `MAXIMUM_MEMORY` | 256MB | Maximum memory with growth |
| `MALLOC` | `emmalloc` | Lightweight allocator |

## Makefile Targets

| Target | Description |
|--------|-------------|
| `all` (default) | Build mrbc |
| `setup-emsdk` | Install and activate Emscripten 5.0.5 |
| `mrbc` | Build mrbc with prerequisite checks |
| `clean` | Remove all build artifacts |
| `rebuild` | Clean and rebuild all |
| `help` | Show available targets |

## Emscripten 5.0.5 Migration Notes

Upgraded from Emscripten 4.0.23. Key changes:

- **Flag syntax**: Use `-sFLAG=value` (without space after `-s`)
- **5.0.0**: LLVM 21.1.8, new `-sEXECUTABLE` setting
- **5.0.1**: `WASM_OBJECT_FILES` setting removed
- **5.0.3**: `FS.write` only accepts TypedArray
- **5.0.5**: C++ exceptions always thrown as CppException objects

## Clean and Rebuild

```bash
make clean    # Remove build artifacts
make rebuild  # Clean + build
```
