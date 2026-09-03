# MCP Server Configuration

KurisuAssistant connects to external tool servers using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Servers are declared in `mcp_config.json` at the project root.

This file is **gitignored** — create it manually when setting up the server.

## Config Format

The file follows the standard `mcpServers` format used by fastmcp and other MCP clients:

```json
{
  "mcpServers": {
    "<server-name>": { ... }
  }
}
```

Each key under `mcpServers` is a server name that becomes the tool's namespace. The value is a server definition using one of the transport types below.

## Transport Types

### SSE (remote server)

Connect to an already-running MCP server over HTTP Server-Sent Events:

```json
{
  "mcpServers": {
    "web-search": {
      "url": "http://web-search-container:8000/sse"
    }
  }
}
```

| Field | Type   | Description              |
|-------|--------|--------------------------|
| `url` | string | SSE endpoint URL (required) |

### Stdio (local process)

Launch a local process and communicate over stdin/stdout:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

| Field     | Type     | Description                        |
|-----------|----------|------------------------------------|
| `command` | string   | Executable to run (required)       |
| `args`    | string[] | Command-line arguments (optional)  |

## How It Works

1. On startup, `mcp_tools/config.py` loads `mcp_config.json` (falls back to empty config if missing).
2. If any servers are configured, a `fastmcp.Client` is created and passed to the MCP orchestrator.
3. Tools exposed by each server are discovered via `list_tools()` and cached for 30 seconds.
4. Agents with the server's tools in their `tools` list can call them during chat.

## Adding a New Server

1. Deploy or start the MCP server (Docker container, local process, etc.).
2. Add an entry to `mcp_config.json` with the appropriate transport config.
3. Restart the API service — tool discovery happens at startup.
4. In the UI, add the new tool names to an agent's tool list so it can use them.

No code changes are needed to register new MCP servers.

## Example: web-search

A web search MCP server running as a Docker container:

```json
{
  "mcpServers": {
    "web-search": {
      "url": "http://web-search-container:8000/sse"
    }
  }
}
```
