# MCP Server Configuration

KurisuAssistant connects to external tool servers using the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

**Servers are configured per user, in the database, through the API.** They are
rows in `mcp_servers`, managed with `/mcp-servers`, and there is nothing to edit on
disk or restart to pick up. The old project-root `mcp_config.json` file is **not
read by any code** — migration `15994df5a1d7_add_mcp_servers_table` imported
whatever it held into the admin account's rows, and nothing has loaded it since.
The file is gitignored and may still be sitting in `backend/`; it does nothing.

## The record

| Field | Type | Notes |
|---|---|---|
| `name` | string | Unique per user |
| `transport_type` | `"sse"` \| `"stdio"` | |
| `url` | string | The SSE endpoint, for `sse` |
| `command` | string | The executable, for `stdio` |
| `args` | string[] | Arguments, for `stdio` |
| `env` | object | Environment, for `stdio` |
| `location` | `"server"` \| `"client"` | Where the server runs. Default `"server"` |
| `enabled` | boolean | Disabled rows are not loaded |

### `location: "server"` — the API container connects out

Only `sse` works here. The per-user `UserMCPOrchestrator` builds one
`FastMCPClient` per enabled row and caches the discovered tools for 30 seconds.

```json
{"name": "web-search", "transport_type": "sse",
 "url": "http://web-search-container:8000/sse", "location": "server"}
```

**A `stdio` server is refused server-side**, on create and on the effective result
of a patch. A stdio entry names a command for the host to run, and these rows are
user-writable through the API, so honouring one would let any account execute
arbitrary commands inside the API container. Migration
`c4f1a9e7d2b3_disable_server_side_stdio_mcp_servers` disabled the ones that already
existed.

TLS certificates are verified. `MCP_TLS_VERIFY=false` turns that off for an
operator with a self-signed server, and logs a warning at startup; it is not a
default anyone should inherit.

### `location: "client"` — the desktop app runs it

This is where `stdio` belongs. The desktop app launches the process on the user's
own machine, discovers its tools, and registers the schemas over the WebSocket with
`client_tools_register`. The backend forwards calls with `tool_call_request` and
waits up to 120s for `tool_call_response`.

```json
{"name": "filesystem", "transport_type": "stdio", "command": "npx",
 "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
 "location": "client"}
```

## Adding a server

1. Deploy or start the MCP server.
2. `POST /mcp-servers` with the record above (the clients have UI for this).
3. Optionally `POST /mcp-servers/{id}/test`, which lists the server's tools. A
   client-side server answers
   `{"status": "unavailable", "error": "Client-side servers are tested from the desktop app"}` —
   the backend cannot reach it.

No restart and no code change. Creating, updating or deleting a row invalidates
that user's cached orchestrator, so the next turn sees the change.

The new tools are available immediately unless `assistants.available_tools` (or a
sub-agent's) is an allowlist that excludes them, and every call is still subject to
`users.tool_policies`. See [Tools & Skills](tools.md).
