# MCP Integration

This document describes the Model Context Protocol (MCP) integration in the
OpenBlink VS Code Extension, which enables AI agents to interact with
OpenBlink devices programmatically.

## Overview

The extension ships a built-in MCP server (`out/mcp-server.js`) that exposes
13 powerful tools to any MCP-compatible AI agent:

### Device Connection Tools

| Tool | Description |
|------|-------------|
| `scan_devices` | Scan for nearby BLE devices and return discovered devices |
| `connect_device` | Connect to a BLE device by its ID |
| `disconnect_device` | Disconnect from the current device |
| `get_device_info` | Get BLE connection state, device name, ID, and MTU |

### Development Tools

| Tool | Description |
|------|-------------|
| `build_and_blink` | Compile a `.rb` file and transfer the bytecode via BLE |
| `validate_ruby_code` | Validate Ruby syntax without building (lightweight check) |
| `soft_reset` | Execute soft reset on the connected device |
| `get_console_output` | Get recent device console output (up to 100 lines) |
| `get_board_reference` | Get the selected board's API reference (Markdown) |

### Debugging & Monitoring Tools

| Tool | Description |
|------|-------------|
| `get_build_diagnostics` | Get detailed build error information with suggestions |
| `get_build_status` | Check if a build is in progress and view build history |
| `cancel_build` | Cancel a pending or in-progress build |
| `get_metrics` | Get compile/transfer time and program size statistics |

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
  status.json            ← Extension writes (debounced 1s): connection, metrics, board, lastBuild
  build-status.json      ← Extension writes: isBuilding, queueLength, lastBuild details
  build-diagnostics.json ← Extension writes: detailed error info, line numbers, suggestions
  openblink-console.log  ← Extension writes (debounced 2s): last 100 device log lines
  scanned-devices.json   ← Extension writes: discovered BLE devices during scan
  trigger.json           → MCP server writes: build request (with requestId, timestamp, type)
  command.json           → MCP server writes: device commands (scan, connect, disconnect, reset, validate, cancel)
  result.json            ← Extension writes: build outcome (with error codes)
  command-result.json    ← Extension writes: command outcomes (devices list, connection info)
```

### IPC Flow

1. **Build Flow**: MCP writes `trigger.json` → Extension detects → Compiles → Writes `result.json`
2. **Command Flow**: MCP writes `command.json` → Extension detects → Executes → Writes `command-result.json`
3. **Status Flow**: Extension detects changes → Debounced write to `status.json`
4. **Diagnostics**: Extension writes detailed build info to `build-diagnostics.json` on failure

### Performance

- `status.json` is only written on significant events (connection changes,
  build completions) with a 1-second debounce
- `openblink-console.log` is written with a 2-second debounce, regardless of how
  frequently the device produces output
- The MCP server only reads files when a tool is invoked (no polling)
- Build status and diagnostics are written immediately for real-time feedback
- When MCP is disabled, zero disk I/O occurs

See [Architecture](architecture.md) for the full system diagram including the
MCP data flow.

## Error Handling

The MCP server provides structured error responses with:

- **Error Codes**: Numeric codes categorized by type (1xxx=general, 2xxx=file, 3xxx=build, 4xxx=BLE, 5xxx=board)
- **Severity Levels**: `info`, `warning`, `error`, `critical`
- **Recovery Suggestions**: Actionable guidance for each error type

Example error response:
```
[Error 3001] WARNING: Syntax validation failed
Details: Line 5, Col 12: [error] unexpected 'end'
Recovery: Review the error details and fix the syntax issues.
```

## Recommended Workflows

### Device Connection Workflow
```
1. scan_devices → Get list of nearby devices
2. connect_device (with deviceId) → Connect to target device
3. get_device_info → Verify connection and check MTU
```

### Development Workflow
```
1. get_board_reference → Read API documentation
2. validate_ruby_code → Quick syntax check (optional)
3. (Edit your .rb file)
4. build_and_blink → Compile and deploy
5. get_console_output → Check device output
6. soft_reset → Restart if needed
```

### Debugging Workflow
```
1. build_and_blink fails
2. get_build_diagnostics → Get detailed error info
3. Fix errors and retry
4. get_build_status → Check if build is stuck
5. cancel_build → Cancel if needed
```
