# System Architecture

This document describes the architecture of the OpenBlink VSCode Extension.

## High-Level Overview

```mermaid
graph TB
    subgraph "VS Code / Windsurf"
        EXT["extension.ts<br/>Entry Point"]
        UI["ui-manager.ts<br/>Output Channel / Status Bar / TreeView"]
        DEV_TV["DevicesTreeProvider<br/>(scan animation, saved devices)"]
        COMP["compiler.ts<br/>mrbc WASM Compiler"]
        BLE["ble-manager.ts<br/>BLE Scan & Connection Manager"]
        PROTO["protocol.ts<br/>OpenBlink Protocol"]
        BOARD["board-manager.ts<br/>Board Configuration"]
    end

    subgraph "WASM Runtime"
        MRBC["mrbc.wasm<br/>(Emscripten MODULARIZE)"]
    end

    subgraph "BLE Device"
        DEV["OpenBlink Device<br/>(mruby/c VM)"]
    end

    EXT --> UI
    EXT --> DEV_TV
    EXT --> COMP
    EXT --> BLE
    EXT --> BOARD
    BLE -->|onScanningStateChanged<br/>onDeviceDiscovered| DEV_TV
    BLE -->|onConnectionStateChanged| DEV_TV
    COMP --> MRBC
    BLE --> PROTO
    PROTO --> DEV
    DEV -->|Console Notifications| BLE
    BLE -->|Console Output| UI
```

## Module Responsibilities

| Module | File | Responsibility |
|--------|------|---------------|
| Entry Point | `extension.ts` | Command registration, module orchestration, saved-device persistence, configuration change listener |
| Compiler | `compiler.ts` | Load mrbc WASM, compile `.rb` → `.mrb`, diagnostic parsing (1-indexed → 0-indexed) |
| BLE Manager | `ble-manager.ts` | Device scan (`startScan`/`stopScan`), connect (`connectById`), disconnect, reconnect, MTU negotiation with floor guard |
| Protocol | `protocol.ts` | OpenBlink BLE protocol (D/P/L/R commands), CRC16, input validation (size/slot/MTU) |
| Board Manager | `board-manager.ts` | Board configurations with runtime JSON validation, sample code, references (defaults to Generic board) |
| UI Manager | `ui-manager.ts` | Output Channel, Status Bar, Diagnostics, TreeView providers (Tasks, DeviceInfo, Metrics, **Devices**, BoardReference) |
| Types | `types.ts` | Shared type definitions, BLE constants (`MIN_USABLE_MTU`, `CHARACTERISTIC_DISCOVERY_TIMEOUT`, etc.), `SavedDevice` |

## Data Flow: Build & Blink

When the user saves a `.rb` file that is focused in the active editor, an
`onDidSaveTextDocument` listener triggers the build-and-blink cycle.  A
concurrency guard (`isBuilding`) prevents overlapping operations — if a build
is already in progress the new request is silently skipped.

```mermaid
sequenceDiagram
    participant User
    participant VSCode as VS Code / Windsurf
    participant Ext as extension.ts
    participant Comp as compiler.ts
    participant WASM as mrbc.wasm (MEMFS)
    participant Proto as protocol.ts
    participant Dev as OpenBlink Device

    User->>VSCode: Save active .rb file (Ctrl+S / Cmd+S)
    VSCode->>Ext: onDidSaveTextDocument(document)
    Ext->>Ext: Guard: active editor matches saved file?
    Ext->>Ext: Guard: isBuilding? (skip if true)
    Ext->>Ext: Read saved file content
    Ext->>Comp: compile(rubyCode)
    Comp->>WASM: FS.writeFile → _main → FS.readFile
    WASM-->>Comp: .mrb bytecode
    Comp-->>Ext: CompileResult {bytecode, compileTime, size}
    alt Compile success + device connected
        Ext->>Proto: sendFirmware(bytecode, slot, mtu)
        Proto->>Dev: [D]ata chunks (MTU-sized)
        Proto->>Dev: [P]rogram header (size, CRC16, slot)
        Proto->>Dev: [L]oad command
    end
    Ext->>UI: Update metrics (TreeView + Status Bar)
    Ext->>UI: log("[COMPILE] success: Xms, size: Y bytes")
    Dev-->>Ext: Console output (BLE notifications)
    Ext->>UI: log("[DEVICE] ...")
```

If the device is not connected, compilation still runs and metrics are recorded, but the BLE transfer is skipped with a warning.

Background saves (e.g. `files.autoSave`, format-on-save of non-focused files) do not trigger a build.  The extension uses `onWillSaveTextDocument` to record saves whose reason is `Manual` and ignores all others, ensuring BLE transfers only occur from explicit user action.
