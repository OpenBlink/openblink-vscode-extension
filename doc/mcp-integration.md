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
| **Windsurf Cascade** | Manual | Add to `~/.codeium/windsurf/mcp_config.json` |
| **Cursor** | Manual | Add to Cursor MCP settings |
| **Cline** | Manual | Add to Cline MCP settings |

## Setup

### VS Code Copilot (Automatic)

No setup required. When the extension is installed, the MCP server is
automatically registered with VS Code Copilot's Agent Mode via the
`mcpServerDefinitionProviders` contribution.

### VS Code Copilot — Workspace configuration (recommended for teams)

Run **OpenBlink: Install MCP Server to Workspace** from the Command
Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) to write a `.vscode/mcp.json`
file at the root of the current workspace. This uses the
[VS Code 1.106+ workspace MCP configuration](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
schema:

```json
{
  "servers": {
    "openblink": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/extension/out/mcp-server.js"],
      "env": {
        "OPENBLINK_IPC_DIR": "/absolute/path/to/workspaceStorage/<hash>/OpenBlink.openblink-extension/ipc",
        "OPENBLINK_EXTENSION_DIR": "/absolute/path/to/extension"
      }
    }
  }
}
```

Committing `.vscode/mcp.json` to your repository lets every collaborator
pick up the OpenBlink MCP server automatically when they open the
workspace in VS Code. Existing `servers` entries in the file are
preserved; only `openblink` is added or overwritten (with a confirmation
prompt if it already exists).

### Windsurf / Cursor / Cline (Manual)

Run the command **OpenBlink: Setup MCP Server** from the Command Palette
(`Ctrl+Shift+P` / `Cmd+Shift+P`) and choose **Show JSON snippet**. This
opens an unsaved editor document with a ready-to-paste configuration for
IDEs that use the legacy `mcpServers` key (Windsurf Cascade, Cursor,
Cline).

Alternatively, add the following to your MCP config manually:

```json
{
  "mcpServers": {
    "openblink": {
      "command": "node",
      "args": ["/path/to/extension/out/mcp-server.js"],
      "env": {
        "OPENBLINK_IPC_DIR": "/absolute/path/to/workspaceStorage/<hash>/OpenBlink.openblink-extension/ipc",
        "OPENBLINK_EXTENSION_DIR": "/absolute/path/to/extension"
      }
    }
  }
}
```

The `OPENBLINK_IPC_DIR` path points at the extension's VS Code
workspaceStorage directory so that IPC files are never written into the
user's workspace tree. The **OpenBlink: Setup MCP Server** command fills
these paths in automatically for the currently opened workspace.

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
| **History (n)** | Collapsible list of up to 50 recent AI-invoked tools |

When MCP is disabled, only the enabled/disabled status is shown.

### Command History

`History (n)` appears as a collapsible section whenever one or more
AI-initiated tool invocations have been observed.  Each child item
shows:

- **Label**: `HH:MM:SS  <tool>` (e.g. `17:45:26  build_and_blink`)
- **Description**: short parameter summary and duration
  (`app.rb  1234ms`, `2 device(s)  800ms`)
- **Icon**: spinner while the tool is running, green check on success,
  red error icon on failure
- **Tooltip**: full request ID, status, parameters, and any detail
  message (error text or success metrics)

The section is **collapsed by default** so the view stays compact.
Click the `Clear MCP History` title-bar button (or run the
**OpenBlink: Clear MCP History** command) to reset the list.

The history is in-memory only (no disk persistence); restarting VS Code
clears it.  The oldest entries are evicted once the 50-entry cap is
reached.

All MCP-related events — history transitions, tool invocations, IPC
errors — are logged to the `OpenBlink` output channel with the `[MCP]`
prefix.  Example output for a successful build invoked by an AI agent:

```
[MCP] build_and_blink received: app.rb (build_550e8400-e29b-41d4-a716-446655440000)
[COMPILE] success: 32.4ms, size: 512 bytes
[TRANSFER] Transfer complete: 134.2ms
[MCP] build_and_blink completed in 178ms (compile 32.4ms, transfer 134.2ms, size 512B)
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `openblink.mcp.enabled` | boolean | `true` | Enable/disable MCP integration |

When disabled:
- No IPC files are written to the workspaceStorage `ipc/` directory
- The trigger file watcher is stopped
- The MCP server definition provider returns an empty array
- Changes take effect immediately without reload

## Architecture

The extension and MCP server run as separate processes, communicating through
JSON files in the extension's VS Code workspaceStorage `ipc/` subdirectory
(e.g. `~/Library/Application Support/Code/User/workspaceStorage/<hash>/OpenBlink.openblink-extension/ipc/`
on macOS). The absolute path is passed to the MCP server via the
`OPENBLINK_IPC_DIR` environment variable, so no files are ever written into
the user's workspace tree.

```
<workspaceStorage>/OpenBlink.openblink-extension/ipc/
  status.json            ← Extension writes (throttled 1s): connection, metrics, board, lastBuild
  build-status.json      ← Extension writes: isBuilding, queueLength, lastBuild details
  build-diagnostics.json ← Extension writes: detailed error info, line numbers, suggestions
  openblink-console.log  ← Extension writes (throttled 2s): last 100 device log lines
  trigger.json           → MCP server writes: build request (with requestId, timestamp, type)
  command.json           → MCP server writes: device commands (scan, connect, disconnect, reset, validate, cancel)
  result.json            ← Extension writes: build outcome (compileTime, transferTime, programSize, compiledWithoutTransfer)
  command-result.json    ← Extension writes: command outcomes (devices list, connection info)
```

All JSON files are written atomically via a `.tmp` sibling + `rename`
so the reader never sees a partially-written file.

### IPC Flow

1. **Build Flow**: MCP writes `trigger.json` → Extension detects → Compiles → Writes `result.json`
2. **Command Flow**: MCP writes `command.json` → Extension detects → Executes → Writes `command-result.json`
3. **Status Flow**: Extension detects changes → Throttled write to `status.json`
4. **Diagnostics**: Extension writes detailed build info to `build-diagnostics.json` on failure

### Performance & Reliability

- **Throttled writes** (at-least-once semantics): `status.json` and
  `openblink-console.log` are written at most once per configured interval
  (`openblink.mcp.statusDebounce`, `openblink.mcp.consoleDebounce`).  Unlike
  pure debounce, the throttler guarantees a flush within the interval even
  under a steady event stream — a chatty device that prints logs every
  100 ms will still see its output flushed to disk every 2 s by default.
- **Atomic writes**: every IPC file is written to a `.tmp` sibling and
  then atomically renamed.  The reader (MCP server or extension watcher)
  therefore never observes a partially-written JSON file.
- **Dual watchers**: the extension pairs VS Code's `FileSystemWatcher`
  with a Node `fs.watch` for each IPC request file.  This redundancy
  works around occasional misses on the workspaceStorage directory
  (which lives outside the workspace and is not always fully covered by
  VS Code's file watcher).
- **Error logging**: I/O failures are logged to the `OpenBlink` output
  channel with an `[MCP]` prefix rather than being silently swallowed.
- The MCP server only reads files when a tool is invoked (no polling).
- Build status and diagnostics are written immediately for real-time feedback.
- When MCP is disabled, zero disk I/O occurs.

### Debug Logging

Set `OPENBLINK_MCP_DEBUG=1` in the MCP server's environment block to
enable verbose stderr logging from the MCP server process.  This logs
every IPC read/write, poll iteration, and timeout, making it easy to
diagnose issues such as:

- Missing console output after `build_and_blink` succeeds
- Tool invocations that time out
- IPC directory misconfiguration

Example (Windsurf `mcp_config.json`):

```json
{
  "mcpServers": {
    "openblink": {
      "command": "node",
      "args": ["/path/to/extension/out/mcp-server.js"],
      "env": {
        "OPENBLINK_IPC_DIR": "/absolute/path/to/ipc",
        "OPENBLINK_EXTENSION_DIR": "/absolute/path/to/extension",
        "OPENBLINK_MCP_DEBUG": "1"
      }
    }
  }
}
```

See [Architecture](architecture.md) for the full system diagram including the
MCP data flow.

## Tool Response Features

### Structured Output (MCP spec 2025-06-18, VS Code 1.103+)

Tools that return structured data expose an `outputSchema` and populate
the `structuredContent` field of their response in addition to the
human-readable `content` text. MCP clients that support structured
output can parse these values directly without regex-based text
scraping.

| Tool | `structuredContent` shape |
|------|---------------------------|
| `build_and_blink` | `{ requestId, success, compileTime?, transferTime?, programSize?, compiledWithoutTransfer? }` |
| `get_device_info` | `{ available, state?, deviceName?, deviceId?, mtu? }` |
| `get_metrics` | `{ available, latest?, stats? }` |
| `get_build_status` | `{ available, isBuilding?, queueLength?, lastBuild? }` |
| `get_build_diagnostics` | `{ available, timestamp?, file?, success?, errors?, suggestions? }` |
| `scan_devices` | `{ success, devices: [...] }` |

The text-only tools (`get_console_output`, `get_board_reference`,
`validate_ruby_code`, `connect_device`, `disconnect_device`,
`soft_reset`, `cancel_build`) retain plain-text responses.

### Resource Links (VS Code 1.103+)

`get_build_diagnostics` and `get_board_reference` attach a
`resource_link` to their `content` array so MCP clients can open the
referenced file directly (for example, VS Code offers a drag-to-chat
affordance and a click-to-open action on linked resources).

- `get_build_diagnostics` links the source `.rb` file whose build
  produced the diagnostics (`mimeType: text/x-ruby`).
- `get_board_reference` links the board's reference Markdown file so
  users can open the full document in a dedicated editor
  (`mimeType: text/markdown`).

### Icons (planned)

Per-tool icons (MCP [SEP-973](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/955))
are not yet wired up because the MCP TypeScript SDK `^1.29.0` exposed
by `@modelcontextprotocol/sdk` does not yet accept an `icons` field on
`McpServer.registerTool`. Icon support will be enabled once the SDK
upgrades to a version that surfaces this API (currently scheduled for
the 2.0 major release).

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

## Troubleshooting

### `get_console_output` returns "No console output available"

1. Verify the OpenBlink extension is running (check the **MCP Status**
   sidebar — `MCP: Enabled` should be shown).
2. Confirm a device is connected and the running mruby program is
   printing output.  The extension logs `[DEVICE] …` lines to the
   **OpenBlink** output channel in real time; if that channel shows no
   output either, the issue is upstream (device, BLE) — not MCP.
3. Wait up to `openblink.mcp.consoleDebounce` milliseconds (default
   2000) after the latest output — the writer flushes at most once per
   interval.
4. If running since before v0.3.5, restart VS Code — older versions
   could stall the log writer under continuous output.
5. Enable `OPENBLINK_MCP_DEBUG=1` and inspect the MCP client's error
   stream; the server logs each `get_console_output` call with the file
   path, byte count, and line count it observed.

### Tool invocations time out

1. Open the **OpenBlink** output channel — `[MCP]` lines show any IPC
   I/O errors the extension encountered.
2. Enable `OPENBLINK_MCP_DEBUG=1` and re-run the tool.  The server logs
   each poll iteration; a timeout with `0 polls` means the extension
   never wrote the result, whereas many polls with `foreignResult=true`
   suggests a stale result file from an aborted request.
3. Check that the **OpenBlink: Setup MCP Server** command output
   matches the `env` block in your MCP config — a mismatched
   `OPENBLINK_IPC_DIR` will make all tools time out.

### Permission errors on IPC files

- **macOS/Linux**: ensure the user running VS Code owns the
  `workspaceStorage/<hash>/OpenBlink.openblink-extension/ipc/` directory.
- **Windows**: antivirus or backup software occasionally locks files
  mid-write.  Add the `workspaceStorage` path to your antivirus
  exclusion list.
