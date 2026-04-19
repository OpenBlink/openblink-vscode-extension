# Changelog

All notable changes to the OpenBlink VSCode Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.5] - 2026-04-19

### Added
- **Workspace MCP configuration (VS Code 1.106+)** — New command
  `OpenBlink: Install MCP Server to Workspace` writes a ready-to-commit
  `.vscode/mcp.json` using the VS Code 1.106+ `servers` schema. Existing
  entries are preserved and the `openblink` entry is added or, on user
  confirmation, overwritten. Teams can commit the file so every
  collaborator picks up the MCP server automatically. The existing
  `OpenBlink: Setup MCP Server` command now presents a chooser between
  workspace install and a copy-paste snippet (for Windsurf / Cursor /
  Cline).
- **Structured MCP output (MCP spec 2025-06-18, VS Code 1.103+)** —
  `build_and_blink`, `get_device_info`, `get_metrics`, `get_build_status`,
  `get_build_diagnostics`, and `scan_devices` now expose an
  `outputSchema` and return `structuredContent` alongside the existing
  `content` text. MCP clients that support the feature can parse the
  results directly without scraping the human-readable summary.
- **MCP resource links (VS Code 1.103+)** — `get_build_diagnostics`
  attaches a `resource_link` to the source `.rb` file that produced the
  diagnostics, and `get_board_reference` attaches a `resource_link` to
  the board's Markdown reference file. VS Code surfaces these as
  drag-to-chat and click-to-open affordances.

### Fixed
- **MCP console log stalling** — `openblink-console.log` was never refreshed
  while the connected device was printing output faster than
  `openblink.mcp.consoleDebounce` (default 2 s), because the previous
  pure-debounce implementation reset the timer on every new line.  Replaced
  with a throttler that guarantees at-least-once flushing per interval, so
  `get_console_output` now reliably returns the latest output from the
  device even under continuous log streams.
- **Partial-write races on IPC files** — All IPC writes (`status.json`,
  `result.json`, `command-result.json`, `build-status.json`,
  `build-diagnostics.json`, `openblink-console.log`) now use an atomic
  temp-file-plus-rename pattern.  The reader (extension or MCP server)
  can no longer observe a half-written JSON, which previously surfaced as
  silent timeouts.
- **Missed file-watcher events on workspaceStorage** — The extension
  now runs a Node `fs.watch` alongside the VS Code `FileSystemWatcher`
  for `trigger.json` and `command.json`.  VS Code's watcher occasionally
  misses events on paths outside the workspace (workspaceStorage lives
  there); the redundant native watcher closes that gap.
- **Silent IPC I/O errors** — Previously all `catch` blocks in the MCP
  bridge swallowed errors with no trace.  All failures are now logged to
  the `OpenBlink` output channel with the `[MCP]` prefix so operators
  can diagnose permission errors, disk-full conditions, etc.

### Added
- **MCP server debug logging** — Set `OPENBLINK_MCP_DEBUG=1` in the MCP
  server's environment block to emit per-tool-invocation, per-poll, and
  per-I/O stderr logs.  Invaluable for diagnosing tool timeouts and IPC
  mismatches.
- **Early IPC validation at MCP startup** — `mcp-server.js` now verifies
  `OPENBLINK_IPC_DIR` at boot and exits with a clear error message if it
  is missing or not an absolute path, instead of failing on the first
  tool call.
- **MCP command history in the sidebar** — The **MCP Status** tree view
  now includes a collapsible `History (n)` section listing up to 50 of
  the most recent AI-agent-initiated tool invocations (build, scan,
  connect, validate, reset, etc.).  Each entry shows the tool name,
  timestamp, parameter summary, duration, and a success/failed icon;
  hovering reveals the full request ID and detail message.  A title-bar
  **Clear MCP History** button (command `openblink.clearMcpHistory`)
  lets the user reset the list at any time.  Every history transition
  (`addHistoryEntry` → `updateHistoryEntry`) is also logged to the
  `OpenBlink` output channel with the `[MCP]` prefix for a durable
  audit trail.

### Removed
- **Windsurf Cascade Hook** — Removed `.windsurf/hooks.json` and `.windsurf/hooks/post_write_rb.sh`. Automatic Build & Blink triggered by Cascade edits is no longer provided via filesystem hooks; use the `build_and_blink` MCP tool explicitly instead.

### Changed
- **IPC directory moved to workspaceStorage** — IPC files (`status.json`, `trigger.json`, `result.json`, etc.) are now written under the extension's VS Code workspaceStorage (`<workspaceStorage>/OpenBlink.openblink-extension/ipc/`) instead of `.openblink/` at the workspace root. The user's workspace is no longer polluted with a `.openblink/` directory.
- **MCP server env var** — `OPENBLINK_WORKSPACE` replaced with `OPENBLINK_IPC_DIR`, which carries the absolute path of the IPC directory. VS Code Copilot users need no action (auto-discovery handles this); other IDE users should re-run the **OpenBlink: Setup MCP Server** command and copy the new configuration.

### Note
- Per-tool icons (MCP SEP-973) are not yet wired up because
  `@modelcontextprotocol/sdk` `^1.29.0` does not expose an `icons` field
  on `McpServer.registerTool`. Icon support will be enabled once the
  SDK upgrades to a version that surfaces this API.
- If your workspace still contains a leftover `.openblink/` directory from a previous version, delete it manually (e.g. `rm -rf .openblink` or via the file explorer). The extension no longer reads or writes this path.

## [0.3.4] - 2026-04-16

### Added
- **Comprehensive MCP integration overhaul** — 8 new MCP tools: `validate_ruby_code`, `scan_devices`, `connect_device`, `disconnect_device`, `soft_reset`, `get_build_diagnostics`, `get_build_status`, `cancel_build`
- **Device command IPC** — File-based IPC via `command.json` / `command-result.json` for device operations from AI agents
- **Build diagnostics IPC** — `build-diagnostics.json` and `build-status.json` for richer AI agent feedback
- **Structured error codes** — `ErrorCode` enum with recovery suggestions in all MCP tool responses
- **Operation cancellation** — `activeOperations` tracking with cancel support in MCP server
- **MCP Status sidebar view** — Shows MCP enabled state, IPC file activity, last request/result
- **Configurable BLE parameters** — `openblink.ble.*` settings: `writeTimeout`, `scanTimeout`, `connectionTimeout`, `maxReconnectAttempts`, `initialReconnectDelay`, `requestedMtu`, `defaultMtu`
- **Configurable MCP parameters** — `openblink.mcp.*` settings: `statusDebounce`, `consoleDebounce`
- **Configurable buffer sizes** — `openblink.console.bufferSize` and `openblink.metrics.historySize` settings
- **Contributing guide** — `doc/contributing.md` and `doc/code-review-checklist.md` (20 categories, 162 items)
- **README enrichment** — Philosophy & Goals, Build & Blink, Thinking Speed Prototyping, Layered Task Architecture, Happy Hacking sections

### Fixed
- **MCP validate routing bug** — `validate_ruby_code` MCP tool was writing to `trigger.json` instead of `command.json`, causing validation requests to be misrouted through the build pipeline and the `code` parameter to be silently ignored
- **SEC-07: Path traversal** — Added `path.isAbsolute()` guard for `OPENBLINK_EXTENSION_DIR` in `mcp-server.ts`
- **STA-13: Compiler double-init** — Added single-flight promise pattern to `initCompiler()` to prevent concurrent WASM double-loading
- **ERR-02: Error typing** — Standardized error typing pattern in compiler init catch handler
- **RDO-10: Unused code** — Removed unused `getBleWriteTimeout` import; prefixed unused parameter with `_`
- **i18n: zh-cn/zh-tw** — Fixed "Forget Device" mistranslation (was "delete"); fixed zh-tw `view.tasks` "工作" → "任務"

### Changed
- All previously hardcoded BLE/MCP constants now read from VS Code workspace configuration
- Improved Japanese translations with child-friendly language and emoji for elementary school users

## [0.3.3] - 2026-04-15

### Fixed
- Include `bluetooth-hci-socket` native binding in Linux VSIX for HCI socket BLE support
- Include noble's `with-custom-binding.js` in VSIX for correct native binding resolution

### Changed
- Improve CI workflows and VSIX packaging reliability
- Quote `$GITHUB_STEP_SUMMARY` in release workflow to avoid word-splitting

## [0.3.2] - 2026-04-15

### Changed
- **Platform-specific VSIX builds** — Release pipeline now produces separate VSIX files per platform (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`) following [VS Code official guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions), ensuring correct native BLE bindings are included for each OS
- **3-job release pipeline** — Restructured `release.yml` into `build-wasm` → `build` (matrix ×4) → `publish` stages
- **GitHub Release** — All platform-specific VSIX files are attached to each release

### Fixed
- Skip native binding verification on Linux (noble uses pure JS HCI socket, no `binding.node`)
- Open VSX publish loop now attempts all platforms even if one fails
- Pin `npx` tool versions (`@vscode/vsce@3`, `ovsx@0`) for reproducible CI builds
- Add top-level `permissions: contents: read` to release workflow (least privilege)
- Include `debug` and `ms` in VSIX (runtime dependencies of `@abandonware/noble`)

## [0.3.0] - 2026-04-13

### Added
- **MCP Integration** — Built-in Model Context Protocol server with 5 AI agent tools (`build_and_blink`, `get_device_info`, `get_console_output`, `get_metrics`, `get_board_reference`), supporting Windsurf Cascade, VS Code Copilot, Cursor, and Cline
- **MCP Status TreeView** — Dedicated sidebar view showing MCP connection activity and build results
- **Cascade Hook** — `post_write_code` hook auto-triggers Build & Blink when `.rb` files are edited by Windsurf Cascade
- **Console ring buffer** — In-memory ring buffer for device console output, accessible via MCP
- **Board configurations** — Built-in support for Generic (mruby/c standard library), M5 Stamp S3, and XIAO nRF54L15
- **Internationalization** — Multi-language UI support for English, Japanese, Simplified Chinese, and Traditional Chinese via `@vscode/l10n`
- **CI/CD workflows** — GitHub Actions for CI (lint + build + test on 3 OS × 2 Node versions), WASM build, and release automation
- **Comprehensive documentation** — Architecture, BLE protocol, build system, compiler, board configuration, i18n, and contributing guides
- **BLE device management** — Dedicated Devices TreeView with scan/stop buttons, real-time discovery, connection animations, saved-device persistence, and auto-reconnect
- **Metrics TreeView** — Compile time, transfer time, and program size with min/avg/max statistics
- **Board Reference TreeView** — Per-board API reference displayed in the sidebar
- **`openblink.setupMcp` command** — Generates MCP configuration snippets for supported AI coding assistants

### Changed
- **Full modular rewrite** — Monolithic extension refactored into 7 focused modules (`extension.ts`, `compiler.ts`, `ble-manager.ts`, `protocol.ts`, `board-manager.ts`, `ui-manager.ts`, `types.ts`) plus MCP modules (`mcp-bridge.ts`, `mcp-server.ts`)
- **Webpack dual-entry build** — Separate bundles for the extension and the standalone MCP server
- **Refined auto-build on save** — Build & Blink on save now only triggers for manual saves of the focused `.rb` file (ignores auto-save and background saves)
- **Exclusive build control** — Concurrent build requests are serialized to prevent race conditions

### Fixed
- Strip trailing newlines from BLE console output
- Security, stability, and input validation improvements across all modules
- Dependency vulnerability fixes (`copy-webpack-plugin` v14, ESLint v10, TypeScript v6)

## [0.2.0] - 2025-05-06

### Added
- Ability to select target `.rb` files for building
- Condition "when Ruby source file is open" for file transfer on save

## [0.1.5] - 2025-03-27

### Fixed
- CRC calculation method corrected

### Note
- Final test version before 0.2.0

## [0.1.4] - 2025-03-25

### Changed
- Safe dependency configuration

## [0.1.1] - 2025-03-20

### Added
- Initial release with basic Build & Blink functionality over BLE

[0.3.5]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.3.1...v0.3.2
[0.3.0]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/OpenBlink/openblink-vscode-extension/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/OpenBlink/openblink-vscode-extension/releases/tag/v0.1.5
[0.1.4]: https://github.com/OpenBlink/openblink-vscode-extension/releases/tag/v0.1.4
[0.1.1]: https://github.com/OpenBlink/openblink-vscode-extension/releases/tag/v0.1.1
