# MCP Integration

This document describes the Model Context Protocol (MCP) integration in the
OpenBlink VS Code Extension, which enables AI agents to interact with
OpenBlink devices programmatically.

## Overview

The extension ships a built-in MCP server (`out/mcp-server.js`) that exposes
five tools to any MCP-compatible AI agent:

| Tool | Description |
|------|-------------|
| `build_and_blink` | Compile a `.rb` file and transfer the bytecode via BLE |
| `get_device_info` | Get BLE connection state, device name, ID, and MTU |
| `get_console_output` | Get recent device console output (up to 100 lines) |
| `get_metrics` | Get compile/transfer time and program size statistics |
| `get_board_reference` | Get the selected board's API reference (Markdown) |

## Supported IDEs

| IDE | Discovery | Setup |
|-----|-----------|-------|
| **VS Code Copilot** | Automatic via `mcpServerDefinitionProviders` | None — available in Agent Mode after installation |
| **Windsurf Cascade** | Manual + auto-trigger via Cascade Hook | Add to `~/.codeium/windsurf/mcp_config.json` |
| **Cursor** | Manual | Add to Cursor MCP settings |
| **Cline** | Manual | Add to Cline MCP settings |

## Setup

### VS Code Copilot (Automatic)

No setup required. When the extension is installed, the MCP server is
automatically registered with VS Code Copilot's Agent Mode.

### Windsurf / Cursor / Cline (Manual)

Run the command **OpenBlink: Setup MCP Server** from the Command Palette
(`Ctrl+Shift+P` / `Cmd+Shift+P`). This generates a JSON snippet that you
can copy into your IDE's MCP configuration file.

Alternatively, add the following to your MCP config manually:

```json
{
  "mcpServers": {
    "openblink": {
      "command": "node",
      "args": ["/path/to/extension/out/mcp-server.js"],
      "env": {
        "OPENBLINK_WORKSPACE": "/path/to/your/workspace"
      }
    }
  }
}
```

Replace the paths with the actual paths on your system. The `Setup MCP Server`
command fills these in automatically.

### Windsurf Cascade Hook (Automatic Build & Blink)

The extension includes a Cascade Hook (`.windsurf/hooks.json`) that
automatically triggers Build & Blink whenever Cascade edits a `.rb` file.
This provides a transparent experience — Cascade simply edits Ruby code and
the device updates instantly, without needing to explicitly call the
`build_and_blink` MCP tool.

The hook files live in the repository root so they activate automatically
when you develop this extension itself in Windsurf.  They are **not**
included in the published VSIX because Windsurf reads hooks from the
workspace root, not from the extension installation directory.

To use the Cascade Hook in your own project, copy the `.windsurf/`
directory from this repository to your project root:

```
.windsurf/
  hooks.json
  hooks/
    post_write_rb.sh
```

## MCP Status View

The **MCP Status** view in the OpenBlink sidebar displays real-time information
about the MCP integration:

| Item | Description |
|------|-------------|
| **MCP: Enabled/Disabled** | Current integration state (click to open settings) |
| **Status File** | Last time `status.json` was written |
| **Console Log** | Last time `openblink-console.log` was written |
| **Last Request** | Timestamp and request ID of the last MCP build trigger |
| **Last Result** | Success/Failed status with timestamp (hover for error details) |

When MCP is disabled, only the enabled/disabled status is shown.

All MCP-related events are logged to the OpenBlink Output Channel with the
`[MCP]` prefix for easy filtering.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openblink.mcp.enabled` | boolean | `true` | Enable/disable MCP integration |

When disabled:
- No IPC files are written to `.openblink/`
- The trigger file watcher is stopped
- The MCP server definition provider returns an empty array
- Changes take effect immediately without reload

## Architecture

The extension and MCP server run as separate processes, communicating through
JSON files in the `.openblink/` directory at the workspace root:

```
.openblink/
  status.json    ← Extension writes (debounced 1s): connection, metrics, board
  openblink-console.log  ← Extension writes (debounced 2s): last 100 device log lines
  trigger.json   → MCP server writes: build request
  result.json    ← Extension writes: build outcome
```

### Performance

- `status.json` is only written on significant events (connection changes,
  build completions) with a 1-second debounce
- `openblink-console.log` is written with a 2-second debounce, regardless of how
  frequently the device produces output
- The MCP server only reads files when a tool is invoked (no polling)
- When MCP is disabled, zero disk I/O occurs

See [Architecture](architecture.md) for the full system diagram including the
MCP data flow.
