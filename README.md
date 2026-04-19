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

And the rewrite is fast: it takes no longer than the blink of an eye — that is where the name "Blink" comes from.

### Build & Blink

_Build_ something with your own hands. _Blink_ it into reality.

Build & Blink embodies the spirit of DIY — the simple joy of creating something yourself and watching it come alive on a real device, right in front of you. You do not need to be a professional engineer or ask a manufacturer for permission. If you have an idea, you can try it now, on your own terms, with your own code.

And this is not a toy: the same Build & Blink workflow scales seamlessly into professional development. Engineers use it to tune real products, run factory tests, and iterate on production firmware — all with the same tools and the same instant feedback. OpenBlink exists to put that power in your hands, from your first experiment to your shipping product.

### Thinking Speed Prototyping

When you edit Ruby code and save, the running device reflects the change in under 0.1 seconds. The microcontroller does **not** restart: only the target task is reloaded while everything else — including the BLE connection and debug console — keeps running. This tight feedback loop lets you iterate at the speed of thought.

Conventional approaches to device customization rely on configuration parameters that the firmware developer must define in advance. This creates a dilemma: too few settings and users cannot express what they need; too many and the interface becomes overwhelming and impossible to master. Worse, no pre-designed set of options can ever anticipate every use case.

OpenBlink sidesteps this problem entirely by treating Ruby as a domain-specific language for device behavior. Instead of choosing from a fixed menu, you write code — which means you can **rewrite the logic itself**: replace a state machine, redesign a control algorithm, or completely rethink how the device responds to its inputs, all in a single save. This expressiveness is what sets OpenBlink apart from conventional parameter-tuning approaches.

**Why Ruby?** Ruby was designed from the ground up to make programmers happy — its syntax reads like natural language, and its flexible grammar (optional parentheses, blocks, keyword arguments) makes it one of the best languages for writing clean, self-documenting domain-specific code. This means even someone who has never touched embedded development can read `LED.set(part: :led1, state: true)` and understand what it does. At the same time, [mruby/c](https://github.com/mrubyc/mrubyc) — a lightweight Ruby VM built for microcontrollers — makes it possible to run Ruby on devices with as little as 15 KB of heap memory, and the mruby compiler produces compact bytecode that fits comfortably within a single BLE transfer. Ruby gives OpenBlink the rare combination of **human friendliness and microcontroller fitness**.

### Layered Task Architecture

OpenBlink firmware separates embedded software into three layers:

| Layer | Language | Wirelessly rewritable? |
|-------|----------|------------------------|
| **Critical tasks** (drivers, BLE stack, RTOS) | C | No |
| **UX tasks** (device behavior, LED patterns) | Ruby | Yes |
| **DIY tasks** (end-user programs) | Ruby | Yes |

Only the Ruby layers execute on the [mruby/c](https://github.com/mrubyc/mrubyc) VM. The C layer remains untouched during a Blink, keeping the system stable and the wireless connection alive.

### For Everyone

OpenBlink is designed so that **system designers, mechanical engineers, hobbyists, students, and end users** — not only embedded software engineers — can modify real device behavior.

**For engineers and designers:**
- Tune sensor thresholds, control sequences, and LED feedback patterns on a live product — no rebuild/flash/reboot cycle
- Write factory inspection programs that run alongside production firmware, without embedding test logic into the shipping codebase
- Let mechanical engineers adjust motor timing or haptic feedback on the actual device while it is assembled, rather than going back and forth with the software team
- Achieve **perfect sensory tuning** — in conventional development, dialing in control parameters requires long iteration cycles, but with OpenBlink the device reflects every adjustment instantly, enabling engineers to tune by feel and intuition until the result is exactly right
- Move beyond **one-size-fits-all** products — traditional mass manufacturing targets the statistical average (e.g. the 3σ range), but OpenBlink makes it practical to tailor device behavior to individual users, opening the door to truly personalized products that adapt to each person rather than forcing everyone into the same mold

**For hobbyists and students:**
- Learn embedded programming in Ruby with instant visual feedback — change a line, save, and see the LED pattern change immediately
- Experiment with I2C sensors and actuators interactively, trying different command sequences without recompiling C code
- Build and share creative projects — the wireless connection means you can program a wearable while wearing it
- **Vibe Coding on real hardware** — pair OpenBlink with an AI coding assistant and describe what you want in natural language; the AI writes the Ruby code, you save, and the device does it. The instant feedback loop lets you and the AI iterate together in real time on a physical device, not just a simulator

**For end users ("DIY-able value"):**
- Customize the behavior of a device you own — personalize shortcuts, automate routines, or adapt the product to your specific needs
- Run your own programs on a commercially manufactured device, turning a finished product into a personal platform

Permission-level API restrictions ensure that openness and stability coexist: devices expose only the methods appropriate for each trust level, so manufacturers can safely open their products to user programming.

### From Education to Production

A single ecosystem covers **learning → hobby → production**. The same toolchain, language, and workflow apply whether you are blinking an LED for the first time or shipping a product.

### Happy Hacking

OpenBlink places great importance on the **joy of hacking on real hardware**. Every design decision serves this goal:

- **No fatal mistakes** — A buggy Ruby program cannot brick the device; the C-level firmware and BLE stack keep running, so you can always send a fix. This safety net encourages you to experiment boldly and keep trying — OpenBlink is built for people who learn by doing.
- **Instant feedback** — Changes take effect in under 0.1 seconds, keeping you in a tight edit-test loop without breaking your flow.
- **No restart** — The microcontroller stays running, which means your wireless debug console session is never interrupted.
- **Fully wireless** — Develop on a wearable while you are wearing it, or on a sensor mounted in a hard-to-reach spot — no cables to tether you.

These qualities come together to create a **happy hacking experience** for everyone who builds and blinks.

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
- **MCP Integration** — Built-in [Model Context Protocol](https://modelcontextprotocol.io/) server exposes Build & Blink, device info, console output, metrics, and board reference as AI agent tools (Windsurf, VS Code Copilot, Cursor, Cline), with a dedicated **MCP Status** sidebar view showing connection activity and build results. Supports structured output (MCP spec 2025-06-18), resource links, and workspace-level `.vscode/mcp.json` installation (VS Code 1.106+)

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
