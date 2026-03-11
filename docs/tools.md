# Tools & Skills

## Built-in Tools

(`built_in = True`) — always available to all agents, cannot be excluded. `conversation_id` and `user_id` auto-injected by `execute_tool()`:

- `search_messages`: Text/regex query with date range filtering (results include `frame_id`)
- `get_conversation_info`: Conversation metadata
- `get_frame_summaries`: List past session frames with summaries, timestamps, message counts
- `get_frame_messages`: Get messages from a specific past session frame by ID
- `get_skill_instructions`: On-demand skill lookup by name (uses `user_id`)

## Non-built-in Tools

Available by default, can be excluded via agent's `excluded_tools` JSON array. `_handler` auto-injected:

- `play_music`: Search YouTube and play/enqueue a track
- `music_control`: Pause, resume, skip, stop playback
- `get_music_queue`: Get current player state and queue
- `route_to_agent`, `route_to_user`: Administrator routing tools

## MCP Tools

Per-user, managed via CRUD API (`/mcp-servers`). Stored in `mcp_servers` DB table with `location` column (`"server"` or `"client"`).

### Server-side (external)

Each user has their own `UserMCPOrchestrator` with 30s tool cache; only loads `location="server"` servers.

### Client-side (internal)

Electron app starts local MCP server processes, discovers tools, registers schemas with backend via `client_tools_register` WebSocket event. Tool calls forwarded via `tool_call_request`/`tool_call_response` WebSocket events with 120s timeout. `AgentContext.client_tools` and `client_tool_callback` wire client tools into `SimpleAgent.process()`. Excluded via agent's `excluded_tools` list.

MCP tool schemas injected directly in `SimpleAgent.process()` (not via tool registry).

See [MCP Configuration](mcp-config.md) for server configuration format.

## Skills System

User-editable instruction blocks stored in DB, injected into every agent's system prompt globally. Skills teach the LLM when/how to use capabilities (e.g., music player commands). Independent of tools — a skill can reference multiple tools.

- **Storage**: `Skill` DB model (per-user, unique name constraint). CRUD via `/skills` REST endpoints.
- **Injection**: Skill **names** listed in system prompt via `get_skill_names_for_user()`. Full instructions fetched on-demand via `get_skill_instructions` tool (registered in `tools/__init__.py`, auto-injected `user_id`).
- **Frontend**: "Skills" tab in ToolsWindow with create/edit/delete UI.
