# Tools & Skills

## The server's own tools

Every tool is always offered (#360) — nothing switches one off, and there is no
allowlist. What a call does is the account's permission mode's decision (below),
from whether the tool **only looks**: `BaseTool.read_only`, off unless a tool
sets it. `conversation_id`, `user_id` and the caller's `agent_id` are injected
into the arguments by `BaseAgent.execute_tool`. Registered in `tools/__init__.py`:

- `history_list` — list past conversations
- `history_read` — read a past conversation's messages
- `recall_regex` — exact-wording recall over past conversations **and** drive
  files: a case-insensitive regular expression over the passage index, newest
  first, quoted verbatim with its source
- `recall_semantic` — the same index by meaning: an embedded query against the
  stored embeddings, closest first
- `get_skill_instructions` — on-demand skill lookup by name
- `notify_user` — a notification on every device of the account, with the app
  closed (#353): `title` and `body`, linked to the current conversation so
  tapping it opens it. Calls `notifications.notify()`, the same path as calendar
  reminders. Only looks, and **allowed by default** (below): it never waits, in
  any permission mode — a task with nobody attached has to be able to say it is
  done
- the six task tools — below
- `calendar_create`, `calendar_list`, `calendar_move`, `calendar_repeat`,
  `calendar_delete` — the user's events and reminders (#282). Wall-clock times
  in the account's zone; create, move and repeat answer JSON with the entry,
  which the clients draw as the chat's calendar card. A reminder can repeat
  (#355): `calendar_create` takes the repeat, `calendar_repeat` changes or stops
  it. Nothing on the calendar makes the assistant act. See `calendar.md`

The two recall tools replaced `history_search` (#6): an unindexed `ILIKE` that
truncated hits to 200 characters and cited nothing. They search documents as
well as conversations with no gate of their own: `drive_read` only looks too, so
any mode that lets a recall call run would let it run. See `retrieval.md`.

The tools that only look: `history_list`, `history_read`, `recall_regex`,
`recall_semantic`, `get_skill_instructions`, `notify_user`, `calendar_list`,
`task_list`, `drive_list`, `drive_read`, `delegate_task` (below) and the four
deferred meta-tools. Every other tool changes something.

There are no music or routing tools in the registry. `play_music`,
`music_control`, `get_music_queue`, `route_to_agent` and `route_to_user` were
removed; anything like them now arrives as an MCP tool.

## Task tools

`task_start`, `task_schedule`, `task_list`, `task_update`, `task_stop` and
`task_delete` (`tools/tasks.py`): the assistant plans its own work with them
(#352). They pass the permission mode like any other tool; `task_list` only
looks. In a task run —
no client attached — the five that change something refuse, so a task cannot
plan tasks. Their results are JSON the clients render as cards. See `tasks.md`.

## Drive tools

Registered in the same place. `drive_list` and `drive_read` only look;
`drive_write` and `drive_delete` change something, so Read only refuses them.
`user_id` is injected the same way, and is not in the declared schema — the
model cannot name another account.

- `drive_list` — folder contents
- `drive_read` — text only, bounded at 256 KB; binary is refused rather than
  returned as noise that costs context
- `drive_write` — the parent folder must already exist; `if_exists` is `fail`
  unless the model asks for `overwrite`
- `drive_delete` — hard delete, no trash; a non-empty folder needs
  `recursive: true`, so "delete the notes folder" cannot quietly take a subtree
  nobody mentioned

They all go through the same repository and blob store as `routers/drive.py`, so
the assistant cannot reach anything the HTTP API would refuse. Renaming and
moving are not exposed: those stay human actions. See `drive.md`.

## Deferred (meta) tools

When `assistants.use_deferred_tools` is set, the agent is not handed every schema
at once. `tools/deferred.py` creates a per-session proxy and four meta-tools —
`list_tools`, `search_tools`, `get_tool_schema`, `call_tool` — and the model
discovers what it needs. The server's own tools are still offered directly; the
catalogue the meta-tools search is what arrives from elsewhere — the account's
MCP servers and the connected client. These are created per session, not
registered globally, so they do not appear in `GET /tools`. The tool-round cap rises from 10 to 25 in
this mode, and `call_tool` refuses to invoke itself.

## Permission

**One mode for the account is the whole of tool permission** (#360).
`assistants.permission_mode` is read once per turn onto
`AgentContext.permission_mode`, and `BaseAgent.execute_tool` applies
`agents/permissions.py::decide` before dispatch:

| Mode | A tool that only looks | A tool that changes something |
| --- | --- | --- |
| `ask` (Always ask, the default) | asks | asks |
| `read_only` (Read only) | runs | refused |
| `full` (Full access) | runs | runs |

- a refusal returns a `denied` result immediately and never reaches the client;
- "run" goes ahead without prompting, with or without a client attached;
- "ask" emits `tool_approval_request` to the connected client, whose answer may
  deny or modify the arguments but cannot widen the decision;
- with no client session attached, a call that would ask is **refused**, not
  run — except in a task run, whose approver asks over REST (`tasks.md`).

The mode is set with `PATCH /assistant` (`permission_mode`); the clients change
it from the chat input. `auto` is shown by the clients as coming soon and is
refused (422), and a value `decide` does not know asks. Personas have no tool
field — swapping persona never changes what the assistant can do. There is no
per-tool allow or deny, no allowlist, and no `requires_approval` or `risk_level`
flag.

**Whether a tool only looks** comes from the tool itself, and a tool that does not
say counts as changing something:

- the server's own tools: `BaseTool.read_only`;
- server-side MCP tools: the tool's `readOnlyHint` annotation, read when the
  orchestrator lists them (`mcp_tools/client.py`, `orchestrator.is_read_only`);
- client tools: `read_only: true` beside `type` and `function` in a
  `client_tools_register` entry. The handler takes it off before any model sees
  the schema (`websocket/handlers.py`).

Only Read only needs to know, so the other modes skip the MCP lookup.

**One exception: a tool can be allowed by default** (#353). `BaseTool.allowed_by_default`
(off unless a tool sets it) makes the tool run in every mode, Always ask included.
Only `notify_user` sets it: its whole effect is a notification to the account's own
devices, and a task with nobody attached (#352) must be able to send one.

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
`client_tool_callback` wire them into `MainAgent.process()`. They go through the
same permission mode, applied before the client is ever asked; one the client did
not register as `read_only` counts as changing something.

Registered client tools are dropped when a new socket replaces the session's — they
belonged to that client.

MCP schemas are injected directly in `MainAgent.process()` and `SubAgent.execute()`,
not through the native tool registry.

See [MCP Configuration](mcp-config.md) for the server record format.

## Spawning a sub-agent

There are no saved sub-agents (#354). `delegate_task` (`agents/sub.py`,
`DelegateTaskTool`) is injected as `extra_tools` on the `MainAgent` for each turn —
not registered globally, because it needs the assistant's own configuration. It
takes one argument, `task`, runs a fresh `SubAgent` on the assistant's model,
provider and reasoning switch (never its memory), and returns the sub-agent's
final text. The sub-agent is offered every tool in the registry and the account's
MCP tools, but not `delegate_task` — a helper cannot spawn helpers — and not the
client's tools. `delegate_task` itself only looks; every tool the sub-agent calls
goes through the permission mode like the assistant's own, and a refused or denied
call stops the helper, whose answer then says why (`Sub-agent stopped: …`).

The model sees an ordinary function, so nothing in the call itself marks a
delegation. The tool chunk's `tool_kind: "sub_agent"` is the only signal, and the
server sets it; its `model_name` is the assistant's model.

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
  from the fixed `SUB_AGENT_PROMPT` and its task, and nothing else. `get_skill_instructions` is
  in the registry, so a sub-agent can still call it — it just is not told which skills
  exist.
- **Frontend:** a "Skills" tab in the desktop tools window with create/edit/delete.

See [Skills Format](skills.md).
