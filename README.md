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

## Philosophy & Goals

OpenBlink is driven by the belief that **embedded programming should be accessible to everyone** — not just specialized software engineers.

### A Programmable World

Microcontroller-powered embedded devices are truly **ubiquitous** — woven into every corner of the physical world, from home appliances and wearables to industrial equipment and vehicles — and they directly influence how the real world behaves. Yet the firmware that runs on these devices has traditionally been the exclusive domain of the manufacturer; end users have had no way to modify it.

OpenBlink challenges this status quo. On an OpenBlink-enabled device, **end users themselves can rewrite part of the firmware** — safely and wirelessly — unlocking a future where everyday embedded devices become programmable. Our goal is to realize this vision of a truly _programmable world_.

And the rewrite is fast: it takes no longer than the blink of an eye.

### Thinking Speed Prototyping

The name "Blink" means _"in the blink of an eye."_ When you edit Ruby code and save, the running device reflects the change in under 0.1 seconds. The microcontroller does **not** restart: only the target task is reloaded while everything else — including the BLE connection and debug console — keeps running.

### Layered Task Architecture

OpenBlink firmware separates embedded software into three layers:

| Layer | Language | Wirelessly rewritable? |
|-------|----------|------------------------|
| **Critical tasks** (drivers, BLE stack, RTOS) | C | No |
| **UX tasks** (device behavior, LED patterns) | Ruby | Yes |
| **DIY tasks** (end-user programs) | Ruby | Yes |

Only the Ruby layers execute on the [mruby/c](https://github.com/mrubyc/mrubyc) VM. The C layer remains untouched during a Blink, keeping the system stable and the wireless connection alive.

### For Everyone

OpenBlink is designed so that **system designers, mechanical engineers, hobbyists, students, and end users** — not only embedded software engineers — can modify real device behavior. Example use cases include:

- Tuning sensor thresholds and control sequences on a real product
- Writing factory inspection programs without embedding test logic in the production firmware
- Letting end users customize device behavior ("DIY-able value")

Permission-level API restrictions ensure that openness and stability coexist: devices expose only the methods appropriate for each trust level.

### From Education to Production

A single ecosystem covers **learning → hobby → production**. The same toolchain, language, and workflow apply whether you are blinking an LED for the first time or shipping a product.

### Happy Hacking

OpenBlink places great importance on the **joy of hacking on real hardware**. Every design decision serves this goal:

- **No fatal mistakes** — A buggy Ruby program cannot brick the device; the C-level firmware and BLE stack keep running, so you can always send a fix. This safety net encourages you to experiment boldly and keep trying — OpenBlink is built for people who learn by doing
- **Instant feedback** — Changes take effect in under 0.1 seconds, keeping you in a tight edit-test loop without breaking your flow
- **No restart** — The microcontroller stays running, which means your wireless debug console session is never interrupted
- **Fully wireless** — Develop on a wearable while you are wearing it, or on a sensor mounted in a hard-to-reach spot — no cables to tether you

These qualities come together to create a **happy hacking experience** for everyone who Build & Blinks.

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
2. Search for **OpenBlink**
3. Click **Install**

Requires VS Code 1.96.0 or later.

## Quick Start

1. Click the **OpenBlink** icon in the Activity Bar
2. In the **Devices** view, click the **Scan** (🔍) button to discover nearby OpenBlink devices
3. Click a discovered device to connect — it is automatically saved for future use
4. Open any `.rb` file and press `Ctrl+S` / `Cmd+S` — the file is saved, compiled, and transferred to the device

The currently active `.rb` file in the editor is always the one that gets compiled and transferred. Previously connected devices appear in the **Saved Devices** section and can be reconnected with a single click or removed via the trash icon.

## Contributing

We welcome contributions from the community! Please see:

- [Contributing Guide](doc/contributing.md) — Development setup, code style, and release process
- [Code Review Checklist](doc/code-review-checklist.md) — Optional reference for thorough reviews or when requesting AI-assisted code review

## Documentation

- [Architecture](doc/architecture.md) — System overview with Mermaid diagrams
- [BLE Protocol](doc/ble-protocol.md) — OpenBlink BLE protocol specification
- [Build System](doc/build-system.md) — Emscripten / mrbc WASM build instructions
- [Compiler](doc/compiler.md) — mrbc WASM compiler internals
- [Board Configuration](doc/board-configuration.md) — How to add new board definitions
- [MCP Integration](doc/mcp-integration.md) — AI agent setup for Windsurf, VS Code Copilot, Cursor, and Cline
- [Internationalization](doc/i18n.md) — Multi-language support guide
- [Security](SECURITY.md) — Security policy and dependency audit

## License

BSD-3-Clause — see [LICENSE](LICENSE) for details.
