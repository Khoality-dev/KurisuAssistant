# MCP servers

[← clients/desktop](../CLAUDE.md)

Two directions, easily confused. Servers this client *starts and calls* (below), and the endpoint this app *is* for an external client, which lives in [security.md](security.md#the-built-in-mcp-server).

MCP servers can run locally on the Electron client (`location: "client"`) in addition to the backend (`location: "server"`). Client-side servers reach local files and apps.

**What actually happens on connect**: the built-in host and app tool schemas are collected, Playwright is started *if its auto-start was turned on*, tools are discovered from every locally running server, and the lot is registered with the backend via `client_tools_register`.

Nothing fetches `location: "client"` configs from the backend and spawns them. This document and `mcpService.ts`'s header both claimed it did long after the code stopped, which is what #86 was written from. If that path returns, it goes through `startServer` like everything else — and therefore through the consent prompt below.

**Starting one asks first.** A stdio server is a program running as the user, so `electron/mcp.ts` shows the exact command line (Cancel / Allow once / Always allow) unless it is already approved. Consent is keyed on the command, not the server's name. Playwright is pinned in `src/constants.ts` and its auto-start is off by default; it used to run `npx @playwright/mcp`, unpinned, on every connect.

**The rest of the loop**: Backend stores client tool schemas in handler state and includes them in LLM tool calls. When LLM calls a client tool, backend sends `tool_call_request` via WebSocket → client executes locally → sends `tool_call_response` back → backend continues LLM loop (120s timeout).

**IPC bridge** (`window.electron.mcp`): `startServers(configs)` → `{name, ok, error}[]`, `stopServers()`, `listTools()` → tool schemas, `callTool(name, args)` → `{content, isError}`.

**WebSocket events**: `client_tools_register` (client→server, tool schemas), `tool_call_request` (server→client, request_id + tool_name + args), `tool_call_response` (client→server, request_id + content + is_error).

**UI**: ToolsWindow server cards show Internal/External chip badge. Create/edit dialog has Location dropdown (External=server, Internal=client). Config changes trigger `refreshClientMCPServers()`.
