# OpenBlink VSCode Extension

[![Ask DeepWiki](https://img.shields.io/badge/Ask-DeepWiki-blue)](https://deepwiki.com/OpenBlink/openblink-vscode-extension)
[![CI](https://img.shields.io/github/actions/workflow/status/OpenBlink/openblink-vscode-extension/ci.yml?label=CI)](https://github.com/OpenBlink/openblink-vscode-extension/actions/workflows/ci.yml)

**Edit Ruby, save, and your device changes instantly** — wireless embedded development in < 0.1 seconds, with no restart required.

OpenBlink VSCode Extension brings [OpenBlink](https://github.com/OpenBlink/openblink)'s "**Build & Blink**" experience to VS Code and Windsurf. Write Ruby code, hit save, and watch it compile and transfer to your microcontroller over Bluetooth LE — all within your editor.

## What is OpenBlink?

[OpenBlink](https://github.com/OpenBlink/openblink) is an open-source project that enables **"Thinking Speed Prototyping"** for embedded systems. 

**Key ideas:**

- **Instant rewriting** — Ruby code changes are reflected on the real device in < 0.1 sec, without microcontroller restart
- **Fully wireless** — All program transfer and debug console output run over Bluetooth LE — no cables needed
- **Ruby for embedded** — Use [mruby/c](https://github.com/mrubyc/mrubyc), a lightweight Ruby VM, to develop for microcontrollers with high productivity and readability
- **For everyone** — Not just for embedded engineers. Designed for system designers, mechanical engineers, hobbyists, students, and end users who want to customize their own devices ("DIY-able value")

## Features

- **Build & Blink** — Save any `.rb` file to instantly compile and transfer via BLE to your device
- **BLE Device Management** — Dedicated Devices view with scan/stop buttons, real-time device discovery, connection animations, saved-device persistence, and auto-reconnect
- **mrbc WASM Compiler** — Cross-platform mruby bytecode compilation powered by Emscripten (no native toolchain needed)
- **Device Console** — Real-time output from your device in the Output Channel
- **Board Configurations** — Built-in support for Generic (mruby/c standard library), M5 Stamp S3, and XIAO nRF54L15
- **Slot Selection** — Choose program slot 1 or 2
- **Metrics** — Compile time, transfer time, and program size with min/avg/max statistics in the TreeView
- **Multi-language UI** — English, やさしい日本語, 简体中文, 繁體中文
- **AI-friendly** — Structured `[COMPILE]`/`[TRANSFER]`/`[DEVICE]`/`[BLE]` output for Windsurf Cascade integration
- **MCP Integration** — Built-in [Model Context Protocol](https://modelcontextprotocol.io/) server exposes Build & Blink, device info, console output, metrics, and board reference as AI agent tools (Windsurf, VS Code Copilot, Cursor, Cline), with a dedicated **MCP Status** sidebar view showing connection activity and build results

## Supported Platforms

| Platform | BLE Support |
|----------|-------------|
| macOS | CoreBluetooth via noble |
| Windows | WinRT via noble |
| Linux  **Untested yet** | BlueZ via noble |
| ChromeOS  **Untested yet** | BlueZ via Crostini (Linux container) |

## Installation

1. Open the Extensions view in VS Code / Windsurf (`Ctrl+Shift+X`)
2. Search for **OpenBlink VSCode Extension**
3. Click **Install**

Requires VS Code 1.96.0 or later.

## Quick Start

1. Click the **OpenBlink** icon in the Activity Bar
2. In the **Devices** view, click the **Scan** (🔍) button to discover nearby OpenBlink devices
3. Click a discovered device to connect — it is automatically saved for future use
4. Open any `.rb` file and press `Ctrl+S` / `Cmd+S` — the file is saved, compiled, and transferred to the device

The currently active `.rb` file in the editor is always the one that gets compiled and transferred. Previously connected devices appear in the **Saved Devices** section and can be reconnected with a single click or removed via the trash icon.

## Documentation

- [Architecture](doc/architecture.md) — System overview with Mermaid diagrams
- [BLE Protocol](doc/ble-protocol.md) — OpenBlink BLE protocol specification
- [Build System](doc/build-system.md) — Emscripten / mrbc WASM build instructions
- [Compiler](doc/compiler.md) — mrbc WASM compiler internals
- [Board Configuration](doc/board-configuration.md) — How to add new board definitions
- [MCP Integration](doc/mcp-integration.md) — AI agent setup for Windsurf, VS Code Copilot, Cursor, and Cline
- [Internationalization](doc/i18n.md) — Multi-language support guide
- [Contributing](doc/contributing.md) — Development setup, code guidelines, and release process
- [Security](SECURITY.md) — Security policy and dependency audit

## License

BSD-3-Clause — see [LICENSE](LICENSE) for details.
