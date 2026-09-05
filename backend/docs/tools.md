# Tools & Skills

## Built-in Tools

`built_in = True` — always offered, and they ignore the `available_tools`
allowlist. `conversation_id`, `user_id` and the caller's `agent_id` are injected
into the arguments by `BaseAgent.execute_tool`. Registered in `tools/__init__.py`:

- `history_list` — list past conversations
- `history_read` — read a past conversation's messages
- `history_search` — text search across stored messages
- `get_skill_instructions` — on-demand skill lookup by name

There are no music or routing tools in the registry. `play_music`,
`music_control`, `get_music_queue`, `route_to_agent` and `route_to_user` were
removed; anything like them now arrives as an MCP tool.

## Deferred (meta) tools

When `assistants.use_deferred_tools` is set, the agent is not handed every schema
at once. `tools/deferred.py` creates a per-session proxy and four meta-tools —
`list_tools`, `search_tools`, `get_tool_schema`, `call_tool` — and the model
discovers what it needs. These are created per session, not registered globally,
so they do not appear in `GET /tools`. The tool-round cap rises from 10 to 25 in
this mode, and `call_tool` refuses to invoke itself.

## The allowlist

`assistants.available_tools` is a JSON array of tool names, or `null` for all of
them. `sub_agents.available_tools` is the same field for a sub-agent's own loop.
Personas have no tool field at all — swapping persona never changes what the
assistant can do. Built-in tools ignore the list.

## Permission

**The server decides, and the client can only narrow it.** `users.tool_policies`
(`{"tools": {name: "allow" | "deny"}}`) is read once per turn onto `AgentContext`:

- a stored `deny` returns a `denied` result immediately and never reaches the
  client;
- a stored `allow` runs without prompting;
- anything else emits `tool_approval_request` to the connected client, whose answer
  may deny or modify the arguments but cannot widen the decision;
- with no client session attached, an unapproved call is **refused**, not run.

Policies are managed through `GET`/`PUT`/`PATCH /users/me/tool-policies`. Per-tool
`requires_approval` and `risk_level` flags do not exist.

## MCP Tools

Per-user, managed via CRUD API (`/mcp-servers`). Stored in the `mcp_servers` table
with a `location` column (`"server"` or `"client"`).

### Server-side (`location: "server"`)

Each user has their own `UserMCPOrchestrator` with a 30s tool cache, built from
that user's enabled `location="server"` rows. One `FastMCPClient` per server, no
composite proxy, so tool names are not prefixed.

Only `sse` (URL) transports run server-side. **A `stdio` server is refused**: a
stdio entry names a command for the host to run, and these rows are user-writable,
so honouring one would let any account execute arbitrary commands inside the API
container. TLS verification is on unless `MCP_TLS_VERIFY` is explicitly disabled.

### Client-side (`location: "client"`)

The desktop app starts local MCP server processes on the user's own machine,
discovers their tools, and registers the schemas over the socket with
`client_tools_register`. Calls are forwarded with `tool_call_request` and answered
with `tool_call_response`, with a 120s timeout. `AgentContext.client_tools` and
`client_tool_callback` wire them into `MainAgent.process()`. They are subject to
the same `available_tools` allowlist and the same server-side tool policy, which is
applied before the client is ever asked.

Registered client tools are dropped when a new socket replaces the session's — they
belonged to that client.

MCP schemas are injected directly in `MainAgent.process()` and `SubAgent.execute()`,
not through the native tool registry.

See [MCP Configuration](mcp-config.md) for the server record format.

## Sub-agents as tools

Each enabled sub-agent is wrapped in a `SubAgentTool` adapter and injected as
`extra_tools` on the `MainAgent` for the turn. The adapter's name is the sub-agent's
name snake-cased with an `_agent` suffix, de-duplicated with a numeric suffix when
two names collapse to the same slug. It takes one argument, `task`, and returns the
sub-agent's final text.

The model sees an ordinary function, so nothing in the call itself marks a
delegation. The tool chunk's `tool_kind: "sub_agent"` is the only signal, and the
server sets it.

## Skills System

User-editable instruction blocks stored in the database. Skills teach the LLM
*when and how* to use a capability; they are independent of tools, and one skill can
reference several.

- **Storage:** the `Skill` model, per user, unique name. CRUD via `/skills`.
- **Injection:** skill **names** are listed in the `MainAgent` system prompt via
  `get_skill_names_for_user()`, in a `## Skills` section placed **after** the
  persona's prompt. Full instructions are fetched on demand with the
  `get_skill_instructions` tool.
- **Sub-agents do not get the skills list.** `SubAgent.execute` builds its prompt
  from its own `system_prompt` and nothing else. `get_skill_instructions` is
  built-in, so a sub-agent can still call it — it just is not told which skills
  exist.
- **Frontend:** a "Skills" tab in the desktop tools window with create/edit/delete.

See [Skills Format](skills.md).
