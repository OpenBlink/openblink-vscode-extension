# Production Code Review Checklist

Reusable checklist for production-level code reviews of the OpenBlink VSCode Extension.
Each item has a unique ID for issue/PR cross-referencing.

## Project Context

> **For AI reviewers**: Read this section first to understand the project scope
> before evaluating checklist items.

- **Project**: OpenBlink VSCode Extension — BLE-based microcontroller development with mruby
- **Architecture**: 9 TypeScript modules in `src/`, plus Webpack dual-entry build (extension + MCP server)
- **Key technologies**: VS Code Extension API, `@abandonware/noble` (BLE), Emscripten WASM (mrbc compiler), Model Context Protocol (MCP), `@vscode/l10n` (i18n)
- **Platforms**: macOS, Windows, Linux | VS Code, Windsurf, Cursor, Cline
- **License**: BSD-3-Clause
- **Source modules** (all in `src/`):
  - `extension.ts` — Entry point, command registration, orchestration
  - `ble-manager.ts` — BLE scan, connect, reconnect, MTU negotiation
  - `compiler.ts` — mrbc WASM compiler, diagnostic parsing
  - `protocol.ts` — BLE firmware transfer protocol (D/P/L/R commands), CRC-16
  - `board-manager.ts` — Board config loading, selection, localized references
  - `ui-manager.ts` — Output Channel, Status Bar, Diagnostics, 6 TreeView providers
  - `mcp-bridge.ts` — File-based IPC (`.openblink/` directory) between extension and MCP server
  - `mcp-server.ts` — Standalone stdio MCP server (5 tools for AI agents)
  - `types.ts` — Shared type definitions, BLE constants

## How to Use This Checklist

### For Human Reviewers

Copy the tables into a GitHub Issue or PR comment. Fill the **Status** column:
✅ pass | ⚠️ minor issue | ❌ must fix | ➖ not applicable

### For AI Reviewers (Cascade, Copilot, Cursor, etc.)

1. Read the **Project Context** above and the **Glossary** at the end
2. For each checklist item, read the **Key Files** and **Verification** columns to know where to look and how to verify
3. Use the **Priority** column to triage findings: fix `Critical` and `High` items first
4. When reporting findings, reference the checklist **ID** (e.g., "SEC-02 violation in mcp-bridge.ts:435")
5. Items marked with 🤖 in the Verification column are especially suitable for automated/AI-assisted checking

### Priority Levels

| Priority | Meaning | Action |
|----------|---------|--------|
| **Critical** | Security vulnerability, data loss, or crash in normal use | Must fix before release |
| **High** | Significant bug, reliability issue, or missing validation | Should fix before release |
| **Medium** | Code quality, maintainability, or minor UX issue | Fix in current or next cycle |
| **Low** | Style, documentation, or nice-to-have improvement | Fix when convenient |

---

## 1. Security (SEC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| SEC-01 | Critical | Input validation | All public APIs validate parameters at entry (type, range, empty, null). No unchecked casts from `unknown`. | All `src/*.ts` | 🤖 Search for unchecked `as` casts and public functions without parameter validation | |
| SEC-02 | Critical | Path traversal prevention | File paths from external input (MCP trigger, config, env vars) resolved with `path.resolve()` and checked via `path.relative()` against workspace/extension root. Never use `startsWith()` for path containment checks. | `mcp-bridge.ts`, `mcp-server.ts`, `board-manager.ts` | 🤖 Grep for `startsWith` used on file paths; verify all `path.relative()` checks include `..` guard | |
| SEC-03 | High | BLE console sanitization | Control characters (U+0000–U+0008, U+000B–U+001F, U+007F) stripped from device output before display/logging to prevent terminal injection. | `extension.ts` (onConsoleOutput handler) | 🤖 Verify regex `[\x00-\x08\x0B-\x1F\x7F]` is applied before all display/logging paths | |
| SEC-04 | High | JSON parse safety | All `JSON.parse()` of external data (IPC files, board config) wrapped in try/catch. Malformed input never crashes the extension. | `mcp-bridge.ts`, `mcp-server.ts`, `board-manager.ts` | 🤖 Grep for `JSON.parse` and verify each is inside try/catch | |
| SEC-05 | High | Prompt injection / jacking | MCP tool outputs are bounded (`MAX_REF_SIZE`). No raw user input or device output is interpolated into AI system prompts. Board reference is read-only from the extension directory. | `mcp-server.ts` | Review all MCP tool return values; verify no string interpolation of untrusted data into prompt-like contexts | |
| SEC-06 | Medium | MCP output validation | MCP tool responses use `{ type: 'text', text: string }` typed literals. No arbitrary object passthrough to AI agents. `isError` flag set explicitly on failure. | `mcp-server.ts` | 🤖 Verify all tool handlers return typed `content` arrays with `isError` on error paths | |
| SEC-07 | High | Environment variable validation | `OPENBLINK_WORKSPACE` and `OPENBLINK_EXTENSION_DIR` are validated as absolute paths before use. Relative paths are rejected. | `mcp-server.ts` | 🤖 Grep for `process.env.OPENBLINK_` and verify `path.isAbsolute()` guards | |
| SEC-08 | Medium | Dependency audit | `npm audit` run regularly. Known transitive issues documented in `SECURITY.md` with impact analysis. | `SECURITY.md`, `package-lock.json` | Run `npm audit` and compare output with SECURITY.md | |
| SEC-09 | Critical | Secret management | No hardcoded tokens, keys, or credentials anywhere in the codebase. CI secrets stored in GitHub Secrets with environment protection. | All files | 🤖 Grep for patterns: API keys, tokens, passwords, Bearer, authorization headers | |
| SEC-10 | Medium | Untrusted workspace | `capabilities.untrustedWorkspaces.supported` is `false` in package.json. Extension refuses to activate in untrusted workspaces. | `package.json` | 🤖 Check `capabilities.untrustedWorkspaces` field | |
| SEC-11 | High | WASM sandbox | Emscripten virtual filesystem isolated from the host. Temp files cleaned in `finally` blocks. No `eval()` or dynamic code execution. | `compiler.ts` | 🤖 Verify temp file cleanup in `finally`; grep for `eval(`, `Function(`, `new Function` | |
| SEC-12 | Medium | IPC file atomicity | `trigger.json` consumed atomically (read + unlink in single try block). No TOCTOU gap between existence check and read. | `mcp-bridge.ts` | Review trigger consumption logic; verify no separate `existsSync` before `readFileSync` | |
| SEC-13 | Medium | Shell script injection | `post_write_rb.sh` rejects file paths with control characters and `..` path segments. JSON output uses `printf` with escaped values. | `.windsurf/hooks/post_write_rb.sh` | Review bash script for injection vectors; verify path segment validation | |
| SEC-14 | High | BLE data bounds | Firmware transfer validates content length (1–65535 bytes), slot (1 or 2), and MTU (> DATA_HEADER_SIZE) before sending. CRC-16 checksum guards integrity. | `protocol.ts` | 🤖 Verify range checks at function entry for `sendFirmware`, `sendResetCommand`, etc. | |
| SEC-15 | Medium | Denial of service | Ring buffers capped (console: 100 lines, metrics: 100 entries). MCP build_and_blink has 30s timeout. BLE scan has 10s timeout. | `ui-manager.ts`, `mcp-server.ts`, `ble-manager.ts`, `types.ts` | 🤖 Verify buffer caps and timeout constants | |
| SEC-16 | High | Configuration injection | User-provided configuration values (`openblink.sourceFile`, `openblink.board`, `openblink.slot`) validated before use. Slot constrained to 1 or 2. Source file path validated against workspace. | `extension.ts`, `board-manager.ts` | 🤖 Grep for `getConfiguration('openblink')` and verify each `.get()` is validated | |

## 2. Stability (STA)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| STA-01 | High | Build concurrency guard | `isBuilding` flag prevents overlapping build-and-blink operations. Concurrent requests silently skipped (or warned if user-initiated). | `extension.ts` | 🤖 Verify `isBuilding` set in try and cleared in finally; check all call sites | |
| STA-02 | High | BLE connection guard | `_isConnecting` flag prevents concurrent `connectById()` calls. Returns early if already connecting or connected. | `ble-manager.ts` | 🤖 Verify guard at top of `connectById()` | |
| STA-03 | High | Timer cleanup | All `setTimeout`/`setInterval` handles stored and cleared in `dispose()`, error paths, and state transitions. No leaked timers. | All `src/*.ts` | 🤖 Grep for `setTimeout`/`setInterval` and verify corresponding `clearTimeout`/`clearInterval` | |
| STA-04 | High | Event listener cleanup | Noble listeners stored as bound references and explicitly removed. Console data handler removed before re-subscribe on reconnect. | `ble-manager.ts` | Review `dispose()` and `disconnect()` for listener removal | |
| STA-05 | High | Dispose chain | All disposables registered in `context.subscriptions`. EventEmitters disposed. BLE manager disposed on deactivation. MCP bridge clears timers. | `extension.ts`, all managers | 🤖 Verify all `push(disposable)` calls; check `deactivate()` function | |
| STA-06 | Medium | Error boundaries | All async command handlers wrapped in try/catch with user-facing `showErrorMessage`. Background errors logged without throwing. | `extension.ts` | 🤖 Verify each `registerCommand` callback has try/catch | |
| STA-07 | Medium | WASM re-entry safety | `_main()` re-invocation risks documented. Temp files cleaned in `finally`. Memory allocated/freed per invocation. | `compiler.ts` | Review `compile()` function for resource cleanup | |
| STA-08 | Medium | Debounce correctness | Status and console debounce timers cleared on disable/dispose. No stale writes after MCP disabled. | `mcp-bridge.ts` | 🤖 Verify `clearTimeout` in `disable()` and `dispose()` | |
| STA-09 | Medium | FileSystemWatcher race | `trigger.json` consumed with read + unlink in same try block. Concurrent onDidCreate/onDidChange handlers safely skip if file already consumed. | `mcp-bridge.ts` | Review trigger consumption logic for race conditions | |
| STA-10 | Medium | Graceful degradation | Compilation works without device connection. MCP works without BLE. Extension starts without workspace. | `extension.ts` | Test: activate with no workspace, no device, MCP disabled | |
| STA-11 | Medium | MCP server crash handling | `uncaughtException` and `unhandledRejection` handlers log to stderr and exit. No silent hangs. | `mcp-server.ts` | 🤖 Verify process crash handlers exist at module level | |
| STA-12 | Low | Reconnection backoff | Exponential delay capped at MAX_RECONNECT_ATTEMPTS. User-initiated disconnect suppresses auto-reconnect. | `ble-manager.ts`, `types.ts` | Review reconnection logic and constant values | |
| STA-13 | Medium | Lazy init single-flight | Compiler init uses a single promise to prevent duplicate WASM loading. | `compiler.ts` | 🤖 Verify `compilerInitPromise` pattern prevents concurrent init | |
| STA-14 | Low | Pending manual save cleanup | `pendingManualSave` entries removed after timeout to prevent stale entries. | `extension.ts` | 🤖 Search for `pendingManualSave` and verify cleanup timer | |

## 3. Cross-Platform Compatibility (PLT)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PLT-01 | High | Path separators | Use `path.join()`, `path.resolve()`, `path.relative()` exclusively. No string concatenation with `/` for file paths. | All `src/*.ts` | 🤖 Grep for string path concatenation patterns (e.g., `` + '/'``, `` `${...}/` ``) in non-URL contexts | |
| PLT-02 | High | Path comparison | Use `path.relative()` (not `startsWith()`) for workspace containment checks. | `mcp-bridge.ts`, `mcp-server.ts` | 🤖 Grep for `startsWith` applied to file paths | |
| PLT-03 | High | Noble platform handling | `@abandonware/noble` native bindings verified per-platform in CI. | `ci.yml`, `release.yml` | Verify CI native binding check steps per OS | |
| PLT-04 | Low | Shell script portability | `post_write_rb.sh` uses bash-specific features. Windows limitation documented. | `.windsurf/hooks/post_write_rb.sh` | Review for POSIX compatibility; check documentation | |
| PLT-05 | Medium | CI matrix | Tests run on 3 OS × 2 Node versions. All combinations green. | `ci.yml` | Verify matrix definition and recent CI results | |
| PLT-06 | High | VSIX platform targets | Release builds separate VSIX per target platform with correct native bindings. | `release.yml` | Verify matrix; check `bluetooth-hci-socket` removal for non-Linux | |
| PLT-07 | Medium | Line endings | No `\r\n` assumptions in parsing. Path traversal regex uses `[\\/]+`. | `mcp-server.ts`, `mcp-bridge.ts` | 🤖 Grep for `\r` handling in split/parse logic | |
| PLT-08 | Low | Filesystem case sensitivity | `forceConsistentCasingInFileNames: true` in tsconfig.json. | `tsconfig.json` | 🤖 Verify tsconfig flag | |
| PLT-09 | High | Native binding whitelist | `.vscodeignore` whitelists noble's runtime dependencies correctly. | `.vscodeignore` | 🤖 Verify whitelist entries against noble's runtime dependency tree | |
| PLT-10 | Low | Node.js version | CI and release use consistent Node versions. `engines` field in package.json reflects minimum. | `package.json`, `ci.yml`, `release.yml` | 🤖 Compare `engines.node` with CI matrix | |

## 4. Multi-IDE Compatibility (IDE)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| IDE-01 | High | VSCode API minimum | `engines.vscode` version matches all APIs used. | `package.json` | Check VS Code API docs for each API; verify availability at declared minimum | |
| IDE-02 | High | Copilot MCP auto-discovery | `mcpServerDefinitionProviders` in package.json + `registerMcpServerDefinitionProvider` guarded by feature detection. | `package.json`, `extension.ts` | 🤖 Verify `typeof` guard before `vscode.lm.registerMcpServerDefinitionProvider` | |
| IDE-03 | Medium | Windsurf Cascade Hook | `.windsurf/hooks.json` and `post_write_rb.sh` present and excluded from VSIX. | `.windsurf/`, `.vscodeignore` | 🤖 Verify `.windsurf/**` in `.vscodeignore` | |
| IDE-04 | Medium | Cursor/Cline setup | `openblink.setupMcp` command generates correct MCP config JSON with dynamic paths. | `extension.ts` | Run command and validate generated JSON structure and paths | |
| IDE-05 | Medium | Open VSX publishing | Release pipeline publishes to Open VSX with failure isolation. | `release.yml` | Verify Open VSX publish step with `continue-on-error` | |
| IDE-06 | High | API feature detection | Optional APIs (`vscode.lm`) checked with `typeof` before use. Extension works in IDEs without these APIs. | `extension.ts` | 🤖 Grep for optional API calls; verify `typeof` or `?.` guards | |

## 5. Reliability (REL)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| REL-01 | High | BLE timeout guards | All BLE operations have timeout guards. Constants defined in `BLE_CONSTANTS`. | `ble-manager.ts`, `protocol.ts`, `types.ts` | 🤖 Verify every BLE async operation has a timeout | |
| REL-02 | High | MTU floor guard | Negotiated MTU clamped to minimum usable value. Guarantees ≥1 payload byte per packet. | `ble-manager.ts`, `types.ts` | 🤖 Verify `Math.max(negotiated, MIN_USABLE_MTU)` pattern | |
| REL-03 | Medium | Auto-reconnect | Exponential backoff with max attempts. User-initiated disconnect suppresses. Timer cancelled on dispose. | `ble-manager.ts` | Review reconnection logic; verify timer cleanup on dispose | |
| REL-04 | High | Build result correlation | `requestId` in trigger.json matched to result.json. Stale results ignored. | `mcp-bridge.ts`, `mcp-server.ts` | 🤖 Verify `requestId` comparison in result polling | |
| REL-05 | Low | Scan grace period | Extra time when waiting for a saved device. Deadline timer prevents interval leak. | `ble-manager.ts`, `extension.ts` | Review scan timeout logic | |
| REL-06 | Medium | Compiler lazy init | Single-flight promise prevents duplicate WASM initialization. Error returns graceful CompileResult. | `compiler.ts` | 🤖 Verify promise caching and error handling in `initCompiler()` | |
| REL-07 | Low | MCP deferred init | Configurable delay for MCP bridge init. `shouldInitialize()` checks prerequisites. | `mcp-bridge.ts`, `extension.ts` | Review init gating logic | |
| REL-08 | Medium | Pre-existing trigger | Watcher checks for existing `trigger.json` after starting. | `mcp-bridge.ts` | Verify post-watch existing file check | |

## 6. Performance (PRF)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PRF-01 | High | Lazy initialization | BLE manager, WASM compiler, MCP bridge all initialized on first use. No heavy work during `activate()`. | `extension.ts` | Review `activate()` for synchronous heavy work; verify lazy patterns | |
| PRF-02 | Medium | Activation event | `onStartupFinished` (not `*`) to avoid blocking IDE startup. | `package.json` | 🤖 Check `activationEvents` field | |
| PRF-03 | Medium | Debounced IPC writes | Status and console writes debounced. Prevents excessive disk I/O during rapid state changes. | `mcp-bridge.ts` | 🤖 Verify debounce implementation with `setTimeout` pattern | |
| PRF-04 | Low | Single-pass statistics | `calculateStats()` uses O(n) loop. No spread-based min/max that could stack overflow. | `ui-manager.ts` | 🤖 Review `calculateStats` implementation | |
| PRF-05 | Medium | Bounded buffers | Console and metrics ring buffers capped. Oldest entries evicted. | `ui-manager.ts` | 🤖 Verify buffer size caps and eviction logic | |
| PRF-06 | Low | Webpack bundling | Two entry points. Production mode. `nosources-source-map`. | `webpack.config.js` | 🤖 Verify `mode` and `devtool` settings | |
| PRF-07 | Medium | No polling | File-based IPC uses FileSystemWatcher, not polling. MCP server reads on-demand only. | `mcp-server.ts`, `mcp-bridge.ts` | 🤖 Grep for `setInterval` polling patterns in IPC code | |
| PRF-08 | Medium | Zero I/O when disabled | MCP disabled state produces no file writes and no watcher. | `mcp-bridge.ts` | 🤖 Verify `isEnabled()` check guards all I/O paths | |
| PRF-09 | Low | Bundle size monitoring | Track Webpack output size. Flag unexpected growth. | `webpack.config.js` | Run `npm run compile` and check bundle sizes | |

## 7. Readability & Code Organization (RDO)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| RDO-01 | Medium | Module decomposition | Single-responsibility modules. Entry point orchestrates; each module testable in isolation. No circular imports. | `src/` directory | 🤖 Analyze import graph; detect circular dependencies | |
| RDO-02 | Low | Naming conventions | PascalCase: types/classes/interfaces. camelCase: variables/functions. UPPER_SNAKE_CASE: constants. `_` prefix: private/unused. | All `src/*.ts` | 🤖 Run ESLint `@typescript-eslint/naming-convention` rule | |
| RDO-03 | Medium | TypeScript strict mode | `strict: true` in tsconfig.json. | `tsconfig.json` | 🤖 Verify `strict: true` flag | |
| RDO-04 | Low | ESLint rules | `curly`, `eqeqeq`, `prefer-const`, `no-throw-literal`, naming conventions, no-unused-vars. | `eslint.config.js` | Run `npm run lint` with zero warnings/errors | |
| RDO-05 | Medium | JSDoc comments | All exported functions, classes, interfaces documented. Internal helpers have at least `@brief`. | All `src/*.ts` | 🤖 Grep for exported functions without JSDoc | |
| RDO-06 | Low | SPDX headers | All `.ts` source files start with `SPDX-License-Identifier` and `SPDX-FileCopyrightText`. | All `src/*.ts` | 🤖 Grep for missing SPDX headers | |
| RDO-07 | Low | Structured logging | All output channel messages prefixed with `[CATEGORY]` tags. Machine-parseable for AI agents. | `extension.ts`, `ui-manager.ts` | 🤖 Grep for log calls without `[TAG]` prefix | |
| RDO-08 | Medium | Constants centralization | All timeouts, limits, UUIDs in `BLE_CONSTANTS`. No magic numbers in business logic. | All `src/*.ts` | 🤖 Grep for numeric literals used as timeouts or limits outside `types.ts` | |
| RDO-09 | Low | Module size monitoring | Flag modules exceeding ~500 lines for potential splitting. | `src/ui-manager.ts` | 🤖 Count lines per module | |
| RDO-10 | Low | Dead code | No unused imports, functions, or variables. Unused parameters prefixed with `_`. | All `src/*.ts` | 🤖 Run `npm run lint` | |
| RDO-11 | Low | Consistent code style | Consistent formatting across all modules. No mixed styles. | All `src/*.ts` | 🤖 Run ESLint on entire codebase | |

## 8. Documentation Currency (DOC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| DOC-01 | Medium | Architecture diagrams | Mermaid diagrams match current module structure and data flow. | `doc/architecture.md` | Compare diagram nodes with actual `src/` imports | |
| DOC-02 | Medium | README features list | All features listed exist in code. No vaporware. No unlisted major features. | `README.md` | 🤖 Cross-reference feature list with `package.json` commands | |
| DOC-03 | High | CHANGELOG | Latest entry version matches `package.json` version. All notable changes documented. Links correct and contiguous. | `CHANGELOG.md`, `package.json` | 🤖 Compare `version` with latest CHANGELOG heading; verify `[x.y.z]` links | |
| DOC-04 | Medium | SECURITY.md | Dependency audit findings match current `npm audit` output. | `SECURITY.md` | Run `npm audit` and compare with documented issues | |
| DOC-05 | Medium | Contributing guide | Setup, prerequisites, code style, release process match current workflow. | `doc/contributing.md` | Cross-reference with `package.json` scripts and CI workflows | |
| DOC-06 | Medium | MCP integration doc | Tool list, config snippets, architecture match MCP implementation. | `doc/mcp-integration.md` | 🤖 Compare documented tool names with `server.tool()` calls in `mcp-server.ts` | |
| DOC-07 | Low | Board configuration doc | Directory structure, config.json schema, reference conventions match layout. | `doc/board-configuration.md` | Compare with `resources/boards/` directory | |
| DOC-08 | Low | BLE protocol doc | Packet formats, header sizes, CRC polynomial match implementation. | `doc/ble-protocol.md` | 🤖 Compare constants with `protocol.ts` | |
| DOC-09 | Low | Build system doc | Emscripten version, mruby_build_config.rb flags, output paths match Makefile. | `doc/build-system.md` | Compare documented versions with `Makefile` and `wasm-build.yml` | |
| DOC-10 | Low | i18n doc | File list, workflow, key naming conventions match l10n files. | `doc/i18n.md` | Compare with `l10n/` and `package.nls.*` files | |

## 9. Internationalization & Translation (I18N)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| I18N-01 | High | package.nls key parity | All keys in `package.nls.json` exist in every `package.nls.{locale}.json`. No missing or extra keys. | `package.nls.json`, `package.nls.ja.json`, `package.nls.zh-cn.json`, `package.nls.zh-tw.json` | 🤖 Diff key sets across all 4 files | |
| I18N-02 | High | l10n bundle key parity | All keys in `bundle.l10n.json` exist in every `bundle.l10n.{locale}.json`. No missing or extra keys. | `l10n/bundle.l10n.json`, locale variants | 🤖 Diff key sets across all 4 files | |
| I18N-03 | Medium | No hardcoded strings | All user-facing strings use `l10n.t()` or `%key%` placeholders. Log-only messages may be English. | All `src/*.ts` | 🤖 Grep for string literals in `showErrorMessage`, `showWarningMessage`, `showInformationMessage`, TreeItem labels | |
| I18N-04 | Medium | Placeholder consistency | `{0}`, `{1}` etc. present in all translations matching the source string. No missing or extra placeholders. | All `l10n/` and `package.nls.*` files | 🤖 Regex for `\{[0-9]+\}` and compare counts across locales | |
| I18N-05 | Low | Board reference localization | Boards with localized references provide `.ja.md`, `.zh-cn.md`, `.zh-tw.md` where applicable. Fallback to `reference.md` works. | `resources/boards/*/` | Verify localized reference files; test fallback in `board-manager.ts` | |
| I18N-06 | Low | Translation quality | Translations are natural and contextually accurate. Chinese uses correct simplified/traditional variants. | All locale files | Human review by native speakers | |
| I18N-07 | Medium | New string coverage | When adding new `l10n.t()` calls, all 4 locale bundles and all 4 package.nls files updated simultaneously. | All `l10n/` and `package.nls.*` files | 🤖 Count keys per file; flag mismatches | |

## 10. VSIX Packaging (PKG)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PKG-01 | High | .vscodeignore completeness | Excludes: `src/`, `vendor/`, `node_modules/` (except noble + deps), `.github/`, `doc/`, `.windsurf/`, `*.ts`, `*.map`, dev config files. | `.vscodeignore` | 🤖 Review exclusion patterns; run `vsce ls` and check for unexpected files | |
| PKG-02 | High | Required inclusions | Includes: `out/extension.js`, `out/mcp-server.js`, WASM files, board resources, icons, l10n, package.nls, LICENSE, README, CHANGELOG. | `.vscodeignore`, `webpack.config.js` | Run `vsce ls` and verify all required files are present | |
| PKG-03 | High | Noble native bindings | Platform-specific `.node` files per VSIX target. Linux includes `bluetooth_hci_socket.node`. Non-Linux strips bluetooth-hci-socket. | `release.yml`, `.vscodeignore` | Verify release matrix and per-platform binding removal | |
| PKG-04 | Medium | No dev artifacts | Test output, source maps, TypeScript source, lock file, config files excluded. | `.vscodeignore` | 🤖 Run `vsce ls` and grep for test/dev files | |
| PKG-05 | Medium | VSIX size monitoring | Track VSIX size per platform. Flag unexpected growth. Ensure vendor/emsdk and vendor/mruby never included. | `release.yml` | Compare VSIX sizes across releases; verify vendor exclusion | |
| PKG-06 | Low | Icon file | `resources/icons/openblink.png` referenced in package.json exists and is reasonable size. | `package.json`, `resources/icons/` | 🤖 Verify icon file exists and `package.json` `icon` field is correct | |
| PKG-07 | Medium | Extension manifest | `package.json` fields: name, displayName, description, version, engines, publisher, icon, license, repository, categories, keywords all present and correct. | `package.json` | 🤖 Validate required fields per VS Code extension manifest spec | |

## 11. CI/CD Pipeline (CIC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| CIC-01 | High | CI matrix coverage | 3 OS × 2 Node versions. Lint, build, and test all pass. Native binding verification per platform. | `ci.yml` | Verify matrix definition and recent CI results | |
| CIC-02 | High | Release pipeline | `build-wasm` → `build` (matrix ×4 platforms) → `publish`. Dependencies correctly chained with `needs`. | `release.yml` | Review job dependency chain | |
| CIC-03 | High | Version consistency | Release workflow verifies tag version matches `package.json` version. Fails early on mismatch. | `release.yml` | 🤖 Verify version check step exists | |
| CIC-04 | Medium | Least-privilege permissions | Default `contents: read`. `contents: write` only in publish job. No unnecessary token scopes. | `ci.yml`, `release.yml` | 🤖 Review `permissions` blocks in all workflows | |
| CIC-05 | Medium | Secret management | `AZURE_PAT`, `OPEN_VSX_PAT` in secrets. `GITHUB_TOKEN` auto-provided. Environment protection on production. | `release.yml` | Verify secrets usage and environment protection in GitHub settings | |
| CIC-06 | Medium | Failure isolation | Marketplace and Open VSX publish use `continue-on-error: true`. GitHub Release always created. Summary table generated. | `release.yml` | 🤖 Verify `continue-on-error` on publish steps | |
| CIC-07 | Low | WASM build trigger | `wasm-build.yml` triggered only by relevant file changes. | `wasm-build.yml` | 🤖 Review `paths` filter in workflow trigger | |
| CIC-08 | Low | Artifact retention | WASM artifacts: 30 days. VSIX artifacts: default retention. | `wasm-build.yml`, `release.yml` | 🤖 Check `retention-days` in `upload-artifact` steps | |
| CIC-09 | Medium | Toolchain pinning | Emscripten, Ruby, vsce, ovsx versions pinned to specific versions. | `Makefile`, `wasm-build.yml`, `release.yml` | 🤖 Verify explicit version numbers in all setup steps | |
| CIC-10 | Low | Node version alignment | CI and release use consistent Node versions. | `ci.yml`, `release.yml` | 🤖 Compare Node versions across all workflows | |

## 12. Dependency Management (DEP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| DEP-01 | Medium | Justified dependencies | Every production dependency has a clear purpose. No unused packages. | `package.json` | 🤖 Cross-reference `dependencies` with `import` statements in `src/` | |
| DEP-02 | Low | Version ranges | Caret (`^`) ranges for safe updates. No wildcard (`*`) or tilde (`~`) where caret is appropriate. | `package.json` | 🤖 Review version range specifiers | |
| DEP-03 | High | Lock file committed | `package-lock.json` committed and consistent with `package.json`. `npm ci` works in clean env. | `package-lock.json` | Run `npm ci` in a clean clone | |
| DEP-04 | Low | Dev/prod separation | Build and test tools in `devDependencies`. Runtime libraries in `dependencies`. | `package.json` | 🤖 Verify each dependency is in the correct section | |
| DEP-05 | Medium | Audit status | `npm audit` results reviewed and documented. | `SECURITY.md` | Run `npm audit` and compare with SECURITY.md | |
| DEP-06 | High | Native addon compat | `@abandonware/noble` compiles on all CI platforms. Pre-built binaries available. | `ci.yml` | Verify native binding check steps pass on all platforms | |
| DEP-07 | Medium | Submodule hygiene | Git submodules (`vendor/emsdk`, `vendor/mruby`) pinned to specific commits. `.gitmodules` paths correct. | `.gitmodules`, `vendor/` | 🤖 Verify `.gitmodules` entries and submodule commit SHAs | |

## 13. Error Handling & Logging (ERR)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| ERR-01 | High | User-facing errors | Actionable errors shown via `showErrorMessage`. Non-actionable errors logged only. No silent swallowing of user-visible failures. | `extension.ts` | Review all `catch` blocks; verify user-visible failures are surfaced | |
| ERR-02 | Medium | Error typing pattern | `error instanceof Error ? error.message : String(error)` used consistently. No `(error as any).message`. | All `src/*.ts` | 🤖 Grep for `error.message` without `instanceof` guard and `as any` casts | |
| ERR-03 | Low | Silent failures justified | Each silent catch has a comment explaining why. | All `src/*.ts` | 🤖 Grep for empty catch blocks or catch without logging/comment | |
| ERR-04 | Medium | Structured log format | All output channel lines prefixed with `[CATEGORY]` tags. Machine-parseable for AI agents. | `extension.ts`, `ui-manager.ts` | 🤖 Grep for log calls without `[TAG]` prefix | |
| ERR-05 | High | No leaked internals | User-facing messages do not expose file paths, stack traces, internal state, or implementation details. | All `src/*.ts` | 🤖 Review all `showErrorMessage`/`showWarningMessage` for path or stack leaks | |
| ERR-06 | Low | Warning vs Error | `showWarningMessage` for non-blocking issues. `showErrorMessage` for blocking failures. | `extension.ts` | Review message severity classification | |
| ERR-07 | Medium | Error recovery guidance | User-facing error messages include a suggested next action where possible (e.g., "Check Bluetooth is enabled", "Reconnect device"). | `extension.ts` | Review error message text for actionability | |

## 14. Type Safety & API Contracts (TYP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| TYP-01 | High | Strict mode | `strict: true` in tsconfig.json (implies `noImplicitAny`, `strictNullChecks`, etc.). | `tsconfig.json` | 🤖 Verify `strict: true` | |
| TYP-02 | Medium | Explicit return types | All exported async functions have explicit return type annotations. | All `src/*.ts` | 🤖 Grep for exported `async function` without `: Promise<` return type | |
| TYP-03 | Low | Discriminated unions | `ConnectionState` is a string union type, not bare `string`. | `types.ts` | 🤖 Verify type definition | |
| TYP-04 | Medium | Runtime validation | Board config JSON validated for required fields at load time. Invalid configs skipped with `continue`. | `board-manager.ts` | Review JSON load logic; verify field presence checks | |
| TYP-05 | High | MCP input schemas | Zod schemas validate all MCP tool inputs. Constraints match business rules. | `mcp-server.ts` | 🤖 Verify all `server.tool()` calls use Zod schemas; check bounds | |
| TYP-06 | Medium | Command argument checks | Command handler arguments validated with `typeof` guards. | `extension.ts` | 🤖 Grep for command handlers; verify argument validation | |
| TYP-07 | Medium | No unsafe casts | No `as any` casts. Noble types extended via intersection types. | All `src/*.ts` | 🤖 Grep for `as any` | |
| TYP-08 | Low | Enum exhaustiveness | Switch statements on union types handle all variants or have explicit `default` with `never` assertion. | All `src/*.ts` | 🤖 Grep for `switch` on typed values; verify exhaustiveness | |

## 15. Testing (TST)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| TST-01 | Medium | Existing unit tests | `protocol.test.ts` covers CRC16: empty data, single byte, known data, determinism, collision, large data. | `src/test/suite/protocol.test.ts` | Run `npm test` and verify all tests pass | |
| TST-02 | High | Coverage gaps | Modules without unit tests: compiler, board-manager, mcp-bridge, mcp-server, ui-manager, ble-manager, extension. | `src/test/suite/` | 🤖 List `src/*.ts` modules vs `src/test/suite/*.test.ts`; identify untested modules | |
| TST-03 | Low | Test configuration | `.vscode-test.mjs`: TDD UI, appropriate timeout, correct glob pattern. | `.vscode-test.mjs` | 🤖 Verify test runner configuration | |
| TST-04 | Medium | CI test execution | Linux uses `xvfb-run` for headless VS Code tests. macOS/Windows run directly. | `ci.yml` | 🤖 Verify conditional `xvfb-run` in CI | |
| TST-05 | Medium | Regression discipline | New bugs should get a failing test before the fix is applied. | Process | Enforce via PR review process | |
| TST-06 | Medium | Integration testing | Manual F5 testing documented. No automated integration tests yet. | `doc/contributing.md` | Review documentation for manual test procedures | |
| TST-07 | Low | Test isolation | Tests do not depend on external state (BLE hardware, network, filesystem). Use mocks where needed. | `src/test/` | Review test implementations for external dependencies | |
| TST-08 | Medium | Boundary value tests | Edge cases tested: empty input, max-length input, zero-length buffer, max MTU, min MTU. | `src/test/suite/` | 🤖 Review test cases for boundary conditions | |

## 16. Accessibility (A11Y)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| A11Y-01 | Medium | TreeView labels | All TreeItem instances have descriptive `label` and `tooltip` properties for screen readers. No icon-only items without labels. | `ui-manager.ts` | 🤖 Grep for `new vscode.TreeItem` and verify `label`/`tooltip` are set | |
| A11Y-02 | Medium | Status bar accessibility | Status bar items have `tooltip` and `accessibilityInformation` where applicable. | `ui-manager.ts`, `extension.ts` | 🤖 Grep for `createStatusBarItem` and verify `tooltip` | |
| A11Y-03 | Low | Error message clarity | Error messages are descriptive enough for users relying on assistive technology. No visual-only status indicators. | All `src/*.ts` | Review error messages for clarity without visual context | |
| A11Y-04 | Low | Command palette discoverability | All user-invocable commands registered in `package.json` with descriptive titles. No hidden-only commands for common operations. | `package.json` | 🤖 Verify `commands` contribution has clear `title` for each | |
| A11Y-05 | Low | Keyboard navigation | All extension features accessible via keyboard (command palette, keybindings). No mouse-only interactions. | `package.json`, `extension.ts` | Test all features via command palette without mouse | |

## 17. Backward Compatibility (BWC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| BWC-01 | High | Configuration migration | When changing/renaming configuration keys, old values are read and migrated gracefully. No silent settings loss on upgrade. | `extension.ts` | Review configuration read logic for migration paths | |
| BWC-02 | High | Command ID stability | Command IDs (`openblink.buildAndBlink`, etc.) never renamed without deprecation path. External tools (MCP, Cascade hooks) depend on these IDs. | `package.json` | 🤖 Compare command IDs with previous release; flag renames | |
| BWC-03 | Medium | IPC file format stability | `.openblink/` file schemas (status.json, trigger.json, result.json) versioned or backward compatible. MCP server handles old formats gracefully. | `mcp-bridge.ts`, `mcp-server.ts` | Review JSON schema for version field or backward compat | |
| BWC-04 | Medium | Semantic versioning | Version bump matches change scope: patch for fixes, minor for features, major for breaking changes. | `package.json`, `CHANGELOG.md` | Compare CHANGELOG entries with version bump level | |
| BWC-05 | Low | Deprecation notices | Deprecated features, APIs, or configuration keys emit warnings before removal. | `extension.ts` | 🤖 Grep for deprecated features; verify user-facing notices | |

## 18. Privacy & Data Handling (PRI)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| PRI-01 | High | No telemetry without consent | Extension does not collect or transmit telemetry, analytics, or usage data. If telemetry is added, it must be opt-in with clear disclosure. | All `src/*.ts` | 🤖 Grep for HTTP/HTTPS requests, `fetch`, `XMLHttpRequest`, telemetry APIs | |
| PRI-02 | Medium | Local-only data | All data (BLE logs, metrics, IPC files) stored locally in `.openblink/` or extension storage. No cloud sync. | `mcp-bridge.ts`, `extension.ts` | 🤖 Grep for outbound network calls | |
| PRI-03 | Medium | Sensitive data in logs | Device addresses, firmware contents, and user code are not logged at verbose levels that could be unintentionally shared. | `extension.ts`, `ble-manager.ts` | Review log statements for PII or sensitive content | |
| PRI-04 | Low | IPC file cleanup | `.openblink/` IPC files cleaned on extension deactivation or MCP disable. No stale sensitive data on disk. | `mcp-bridge.ts` | 🤖 Verify cleanup in `disable()` and `dispose()` | |

## 19. Repository Hygiene (REP)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| REP-01 | Medium | .gitignore coverage | Build artifacts (`out/`, `dist/`), native bindings, `.openblink/`, OS files, editor files, and `node_modules/` ignored. | `.gitignore` | 🤖 Verify patterns cover all generated files | |
| REP-02 | Medium | Submodule status | `vendor/emsdk` and `vendor/mruby` submodules are up-to-date and pinned to known-good commits. `.gitmodules` paths are correct. | `.gitmodules`, `vendor/` | Run `git submodule status` and verify commit SHAs | |
| REP-03 | Low | Branch protection | `main` branch requires PR reviews and passing CI before merge. | GitHub settings | Verify branch protection rules in repo settings | |
| REP-04 | Low | Commit message convention | Commits follow a consistent format (e.g., Conventional Commits or project-specific convention). | Git history | Review recent commit messages for consistency | |
| REP-05 | Low | No large binary files | Repository does not contain unnecessary large binaries. WASM files managed via CI artifacts, not committed directly (or kept minimal). | `resources/wasm/` | 🤖 Find files > 1MB in the repository | |

## 20. License & Attribution (LIC)

| ID | Priority | Check | Details | Key Files | Verification | Status |
|----|----------|-------|---------|-----------|--------------|--------|
| LIC-01 | High | License file | `LICENSE` contains BSD-3-Clause full text. | `LICENSE` | 🤖 Verify license text matches BSD-3-Clause template | |
| LIC-02 | Medium | SPDX headers | All `.ts` source files have `SPDX-License-Identifier` and `SPDX-FileCopyrightText`. | All `src/*.ts` | 🤖 Grep for missing SPDX headers | |
| LIC-03 | Medium | Third-party licenses | All dependencies have licenses compatible with BSD-3-Clause. | `package.json` | 🤖 Run `license-checker` or `npm` license audit | |
| LIC-04 | Low | Copyright consistency | Copyright year and entity consistent across all source files and LICENSE. | All source files | 🤖 Grep for `Copyright` and verify consistency | |
| LIC-05 | Medium | No external code without attribution | Files containing code derived from external sources include appropriate license notices. Original files do not include unnecessary third-party notices. | All `src/*.ts` | Review for unattributed external code | |

---

## Glossary

> **For AI reviewers**: These terms have specific meanings in this project.

| Term | Definition |
|------|-----------|
| **BLE** | Bluetooth Low Energy — wireless protocol for communicating with microcontroller devices |
| **mruby/c** | Lightweight Ruby implementation for microcontrollers; compiled to bytecode via `mrbc` |
| **mrbc** | mruby bytecode compiler; runs as WASM module in the extension via Emscripten |
| **MCP** | Model Context Protocol — standardized API for AI agents to interact with tools |
| **MCP Bridge** | Extension-side IPC layer communicating with the MCP server via JSON files in `.openblink/` |
| **MCP Server** | Standalone Node.js process providing MCP tools (build_and_blink, get_device_info, etc.) via stdio |
| **IPC** | Inter-Process Communication — file-based mechanism using `.openblink/` directory |
| **trigger.json** | IPC file written by MCP server to request a build; consumed (read + unlink) by the extension |
| **result.json** | IPC file written by the extension with build results; read by MCP server |
| **status.json** | IPC file with current extension state (connection, device info, board); debounce-written |
| **Noble** | `@abandonware/noble` — Node.js BLE library with native bindings per platform |
| **MTU** | Maximum Transmission Unit — maximum BLE packet size negotiated with the device |
| **VSIX** | VS Code extension package format (ZIP with manifest) |
| **Cascade** | Windsurf IDE's AI assistant; integrates via `.windsurf/hooks.json` |
| **D/P/L/R** | BLE protocol command types: Data, Program-info, List, Reset |
| **CRC-16** | 16-bit Cyclic Redundancy Check used for firmware transfer integrity |
| **TOCTOU** | Time-of-check to time-of-use — race condition class |
| **Single-flight** | Design pattern where concurrent identical requests share one execution |

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2025-04-15 | 1.0 | Initial checklist: 20 categories, 147 items |
