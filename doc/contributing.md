# Contributing

Thank you for your interest in contributing to the OpenBlink VSCode Extension!

## Development Environment Setup

### Prerequisites

- Node.js 18+
- VS Code 1.96.0+
- Git

### Setup

```bash
# Clone with submodules (vendor/emsdk, vendor/mruby)
git clone --recursive https://github.com/OpenBlink/openblink-vscode-extension.git
cd openblink-vscode-extension

# Or initialize submodules in an existing clone
git submodule update --init --recursive

npm install
```

### Development Workflow

```bash
# Watch mode (recompile on changes)
npm run watch

# In VS Code: press F5 to launch Extension Development Host
```

### Building

```bash
npm run compile      # Production build
npm run package      # Create .vsix file
```

### Linting

```bash
npm run lint
```

### Testing

```bash
npm test
```

### Manual Testing with F5

1. Press **F5** in VS Code / Windsurf to launch the Extension Development Host
2. In the new window, open any folder containing `.rb` files
3. Open a `.rb` file and press `Ctrl+S` / `Cmd+S`
4. The active `.rb` file is compiled and (if a device is connected) transferred via BLE
5. Check the **OpenBlink** Output Channel for `[COMPILE]`, `[TRANSFER]`, and `[DEVICE]` messages

## Project Structure

```
src/
├── extension.ts        # Entry point — commands, saved-device persistence, config listener
├── compiler.ts         # mrbc WASM compiler (MODULARIZE), diagnostic parsing
├── ble-manager.ts      # BLE scan/connect, MTU negotiation with floor guard, auto-reconnect
├── protocol.ts         # OpenBlink BLE protocol (D/P/L/R), input validation, CRC16
├── board-manager.ts    # Board configurations with runtime JSON validation
├── ui-manager.ts       # Output Channel, Status Bar, Diagnostics, TreeView providers
│                       #   (Tasks, DeviceInfo, Metrics, Devices, BoardReference)
└── types.ts            # Shared type definitions, BLE constants, SavedDevice
```

## Building mrbc WASM (Optional)

Only needed if you want to rebuild the WASM compiler from source.
Requires additional prerequisites: Python 3, Make, Ruby.

```bash
make setup-emsdk                      # Install Emscripten 5.0.5 (once)
source vendor/emsdk/emsdk_env.sh      # Activate Emscripten
make                                  # Build mrbc.js + mrbc.wasm
```

The `make` command automatically checks for `emcc`, `ruby`, and `rake` before building.
The mruby cross-compilation settings are in `mruby_build_config.rb`.
See [Build System](build-system.md) for details.

## Code Style

- TypeScript with strict mode
- All user-facing strings must use `l10n.t()` for localization
- Source code comments in English
- Output Channel uses structured prefixes: `[COMPILE]`, `[TRANSFER]`, `[DEVICE]`, `[BLE]`, `[SYSTEM]`
- **Input validation**: Public API functions must validate parameters at entry (range, type, empty checks) and throw descriptive errors
- **Error handling**: Prefer user-visible `showErrorMessage` over silent log-only failures for actionable errors
- **Constants**: Timeouts and protocol limits must be defined in `BLE_CONSTANTS` (`types.ts`), not hard-coded as magic numbers
- **Resource cleanup**: `dispose()` methods must release all resources (timers, listeners, BLE connections)

## Security

- Never commit secrets (API keys, tokens, credentials)
- Validate all external input — BLE data, file content, user-provided configuration
- Use `Buffer.readUInt16LE()` / `Buffer.readUInt8()` for binary parsing instead of manual bit-shifting
- Sanitize file paths against path traversal when constructing from user input
- Run `npm audit` regularly and review [SECURITY.md](../SECURITY.md) for known dependency issues

## Adding a New Board

See [Board Configuration](board-configuration.md).

## Adding Translations

See [Internationalization](i18n.md).
