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
│                       #   (Tasks, DeviceInfo, Metrics, Devices, BoardReference, McpStatus)
├── mcp-bridge.ts       # File-based IPC between extension and MCP server
├── mcp-server.ts       # Standalone stdio MCP server (5 tools for AI agents)
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

## Windsurf Cascade Hook

The repository ships with a Cascade Hook (`.windsurf/hooks.json`) that auto-triggers Build & Blink whenever Cascade edits a `.rb` file. This provides a seamless AI-assisted development workflow:

1. Open the project in Windsurf
2. Connect to an OpenBlink device
3. Ask Cascade to edit your `.rb` source file
4. The hook automatically compiles and transfers the updated code to the device

The hook uses the `post_write_code` event. When Cascade writes to a `.rb` file, the script `.windsurf/hooks/post_write_rb.sh` creates a trigger file in `.openblink/`, which the extension's `FileSystemWatcher` picks up to run Build & Blink.

No additional configuration is needed — the hook is included in the repository and activates automatically in Windsurf.  Note that `.windsurf/` is excluded from the published VSIX (Windsurf reads hooks from the workspace root, not from the extension installation directory).  End users who want the hook must copy it to their own project; see [MCP Integration — Cascade Hook](mcp-integration.md#windsurf-cascade-hook-automatic-build--blink).

See [Architecture — MCP Integration](architecture.md#data-flow-mcp-integration) for details on the file-based IPC mechanism.

## Releasing

Releases are automated via GitHub Actions. Pushing a version tag triggers the workflow, which builds **platform-specific VSIX files** and publishes them to all distribution channels.

### Prerequisites

- `VSCE_PAT` — Azure DevOps Personal Access Token with **Marketplace > Manage** scope, stored in GitHub Secrets
- `OVSX_PAT` — Open VSX access token, stored in GitHub Secrets

### Steps

1. Update `version` in `package.json`
2. Update `CHANGELOG.md` with the new version's changes
3. Commit and push to `main`
4. Tag and push:

```bash
git tag v<VERSION>
git push origin v<VERSION>
```

### Release Pipeline

The CI pipeline (`.github/workflows/release.yml`) runs a 3-job workflow:

1. **`build-wasm`** — Builds mrbc WASM from source (Emscripten + Ruby)
2. **`build`** (matrix ×4) — Runs `npm ci` on each OS to compile native BLE bindings, then `vsce package --target <platform>` to create platform-specific VSIXs:
   - `darwin-arm64` (macOS Apple Silicon)
   - `darwin-x64` (macOS Intel)
   - `win32-x64` (Windows)
   - `linux-x64` (Linux)
3. **`publish`** — Downloads all VSIXs and publishes to:
   - **VS Code Marketplace** (`vsce publish --packagePath *.vsix`)
   - **Open VSX** (per-file loop)
   - **GitHub Release** (all VSIX files attached, always created)

Marketplace/Open VSX publish failures are non-fatal warnings — the GitHub Release is always created so VSIX files are available for manual download. Lint and tests run on the Linux matrix runner.

### User Experience

End users do not need to be aware of the platform-specific packaging. VS Code Marketplace and Open VSX automatically serve the correct VSIX for the user's platform. For manual installation from GitHub Releases, users should select the file matching their platform.

See [Build System — Platform-Specific VSIX Packaging](build-system.md#platform-specific-vsix-packaging) for technical details.

### Manual Release (if needed)

```bash
npm run compile
npx @vscode/vsce package --target darwin-arm64   # or other target
npx @vscode/vsce publish --packagePath *.vsix
npx ovsx publish <file>.vsix -p <OVSX_PAT>
```

## Adding a New Board

See [Board Configuration](board-configuration.md).

## Adding Translations

See [Internationalization](i18n.md).
