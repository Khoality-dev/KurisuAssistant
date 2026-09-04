# Agents

Two kinds, distinguished by `agents.agent_type`.

**MainAgent** (`agent_type='main'`) is the one the user talks to. It owns the
identity fields — voice, avatar, character config, preferred name, trigger word —
streams its reply to the client, and runs the tool loop.

**SubAgent** (`agent_type='sub'`) is a worker with no identity. It never streams.
A MainAgent delegates to one by calling it as a tool, and gets a single string
back; the user sees only the MainAgent's account of it.

There is no administrator, router, or group discussion mode. Those existed once
and were removed.

## Choosing the main agent

A conversation binds to one main agent, stored as `conversations.main_agent_id`.
It is null until the first message, then `agents/selection.py` picks:

1. the first enabled main agent whose `trigger_word` appears in the message, on a
   word boundary, case-insensitively;
2. otherwise one at random.

No LLM call is involved. The choice is persisted and the conversation keeps it.

The random fallback means a user with several main agents gets an arbitrary one
per new conversation. That is the current behaviour, not necessarily the intended
one.

## The turn loop

`MainAgent.process` runs at most `MAX_TOOL_ROUNDS` — 10 normally, 25 when the
agent uses deferred tools. Each round calls the model, streams what comes back,
and if the reply contains tool calls, executes them and loops so the model can
react to the results.

Sub-agents run the same shape internally, capped at 10, and return their final
text.

A denied tool ends the loop.

## The system prompt

`_prepare_messages` assembles it in this order:

1. `You are {name}.` plus the agent's own `system_prompt`
2. the user's `system_prompt`, then their preferred name
3. the current time
4. the user's skill names, with an instruction to load one before acting
5. the deferred-tool protocol, when the agent uses it
6. the agent's memory, when `memory_enabled`
7. the conversation's `compacted_context`, when there is one
8. the available sub-agents and what each is for

History follows, replayed with the tool-call linkage intact: an assistant message
carries the `tool_calls` it made, a tool message carries the `tool_call_id` it
answers. Dropping that pairing is an API error on OpenAI-compatible providers.

## Tool access

`agents.available_tools` is a JSON array of tool names, or null for all of them.
Built-in tools ignore it and are always offered.

**Permission is decided by the server, not the client.** `users.tool_policies` is
read once per turn onto `AgentContext`, and `BaseAgent.execute_tool` applies it
before dispatch:

- a stored `deny` returns immediately and never reaches the client;
- a stored `allow` runs without prompting;
- anything else asks the connected client, and that answer can only narrow the
  server's decision;
- with no client attached, an unapproved call is refused rather than run.

A call resolves against the native registry, then handler-injected tools such as
sub-agent adapters, then tools the client registered over the socket, then a
server-side MCP server.

## Memory

Each agent has one free-form markdown document in `agents.memory`, injected into
its system prompt when `memory_enabled` is set.

It is rewritten in the background. `workers/service.py` scans for conversations
idle past `CONVERSATION_IDLE_THRESHOLD_MINUTES` (default 30) and queues one
consolidation per agent that spoke in them and has memory enabled.
`utils/memory_consolidation.py` reads the agent's prompt, its current memory and
the conversation, and asks the model for an updated document. It uses the user's
`summary_model`, so nothing consolidates without one configured.

Editable from the agent dialog in both clients, and over `GET`/`PATCH /agents/{id}`.
