# MCP Client Startup Configuration

PacketCapture-MCP is a stdio MCP server. For IDEs and MCP clients that can read npm scripts, prefer the named scripts below because they keep the startup command stable even if the implementation path changes later.

Ready-to-copy JSON files are available under `docs/clients/`:

- `vscode-mcp.example.json`: VS Code workspace MCP schema using `servers`.
- `cursor-mcp.example.json`: Cursor project or user MCP schema using `mcpServers`.
- `claude-desktop-config.example.json`: Claude Desktop `claude_desktop_config.json` shape.
- `claude-code-project-mcp.example.json`: Claude Code project-scoped `.mcp.json` shape.
- `codex-config.example.toml`: Codex CLI `~/.codex/config.toml` shape.
- `cline-mcp-settings.example.json`: Cline MCP settings shape.
- `roo-mcp.example.json`: Roo Code MCP settings shape.
- `windsurf-mcp_config.example.json`: Windsurf/Cascade MCP settings shape.

## Recommended Local Configuration

Build once before using the production startup command:

```powershell
npm install
npm run build
```

Use this MCP server entry from clients that support a `command` plus `args` shape:

```json
{
  "command": "npm",
  "args": [
    "--prefix",
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
    "run",
    "mcp:start"
  ]
}
```

This runs `node dist/index.js` through the package script and is the best default for IDE startup.

If a client should use the standard package lifecycle command exactly, use `npm start` through `--prefix`:

```json
{
  "command": "npm",
  "args": [
    "--prefix",
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
    "start"
  ]
}
```

## Direct Node Configuration

Clients that do not run npm scripts can call the built entry directly:

```json
{
  "command": "node",
  "args": [
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
  ]
}
```

## Claude Desktop

Add this under `mcpServers` in `claude_desktop_config.json`, then fully restart Claude Desktop.

Common config paths:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Direct `dist/index.js` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
      ],
      "env": {}
    }
  }
}
```

`npm start` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "npm",
      "args": [
        "--prefix",
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
        "start"
      ],
      "env": {}
    }
  }
}
```

## Claude Code CLI

Claude Code can read the project-scoped `.mcp.json` committed at the repository root. When Claude Code first sees a project-scoped MCP server, approve the server in the CLI prompt.

The project config in this repository is:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "node",
      "args": [
        "dist/index.js"
      ],
      "env": {}
    }
  }
}
```

Equivalent CLI registration command:

```powershell
claude mcp add --scope project packetcapture -- node dist/index.js
```

Verify Claude Code can see and connect to the server:

```powershell
claude mcp get packetcapture
claude mcp list
```

If Claude Code has cached a rejected project server choice, reset project choices and approve it again:

```powershell
claude mcp reset-project-choices
```

## Codex CLI

Codex CLI reads MCP servers from `C:\Users\Fhw20\.codex\config.toml` on this machine. Add this server with the CLI:

```powershell
codex mcp add packetcapture -- node C:\Users\Fhw20\Desktop\Code\PacketCapture-MCP\dist\index.js
```

Or add the same entry manually:

```toml
[mcp_servers.packetcapture]
command = "node"
args = ['C:\Users\Fhw20\Desktop\Code\PacketCapture-MCP\dist\index.js']
```

Verify Codex can see the server:

```powershell
codex mcp get packetcapture
codex mcp list
```

This repository also includes `docs/clients/codex-config.example.toml`.

## Cursor

Use either a project-level `.cursor/mcp.json` or a user-level Cursor MCP configuration. Project-level files are useful for local development, but avoid committing personal absolute paths.

Direct `dist/index.js` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
      ],
      "env": {}
    }
  }
}
```

`npm start` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "npm",
      "args": [
        "--prefix",
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
        "start"
      ],
      "env": {}
    }
  }
}
```

## VS Code / Cline

Open Cline's MCP settings from the extension UI and add a server entry. The settings file commonly uses the same `mcpServers` shape plus Cline-specific control fields.

Direct `dist/index.js` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "command": "node",
      "args": [
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
      ],
      "env": {},
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

`npm start` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "command": "npm",
      "args": [
        "--prefix",
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
        "start"
      ],
      "env": {},
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

## VS Code / Roo Code

Roo Code supports global MCP configuration and project-level `.roo/mcp.json`. Use project-level configuration only as a template unless every user shares the same absolute path.

Direct `dist/index.js` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP\\dist\\index.js"
      ],
      "env": {},
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

`npm start` startup:

```json
{
  "mcpServers": {
    "packetcapture": {
      "type": "stdio",
      "command": "npm",
      "args": [
        "--prefix",
        "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
        "start"
      ],
      "env": {},
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

## Optional Reqable Environment

Add these variables to the server entry's `env` object only when you need to override the default Reqable bridge inbox or receiver URL:

```json
{
  "REQABLE_MCP_INBOX": "C:\\path\\to\\reqable-inbox",
  "REQABLE_MCP_EVENTS_FILE": "events.ndjson",
  "REQABLE_MCP_RECEIVER_URL": "http://127.0.0.1:9419/reqable/report/<token>/bridge"
}
```

On Windows, if the client reports `spawn npm ENOENT`, change `"command": "npm"` to `"command": "npm.cmd"` or use the direct `node dist/index.js` template.

## Development Configuration

Use this only while editing the TypeScript sources:

```json
{
  "command": "npm",
  "args": [
    "--prefix",
    "C:\\Users\\Fhw20\\Desktop\\Code\\PacketCapture-MCP",
    "run",
    "mcp:dev"
  ]
}
```

`mcp:dev` runs `tsx src/index.ts`, so it has a higher startup cost than the built server.

## Package Metadata

The package exposes:

- `bin.packetcapture-mcp`: package executable path for npm-aware launchers.
- `main` and `exports["."]`: built JavaScript entry point.
- `files`: publish allowlist including `dist`, `docs`, `examples`, and `README.md`.
- `keywords`: MCP-specific terms to improve search and registry discovery.
