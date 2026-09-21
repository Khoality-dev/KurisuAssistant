# Agents

Three kinds of row, three different jobs. They used to be one `agents` table;
migration `0dacee9f63b8_split_persona_from_assistant` took it apart again.

For what this looks like to a user, see the client screens docs — [Android](../../clients/android/docs/screens.md), [Desktop](../../clients/desktop/docs/screens.md) — where the Assistant
and Personas screens are the split made visible.

**The assistant** (`assistants`) is *what the user's assistant can do*. Exactly one
row per user: model, provider, tool allowlist, reasoning switches, the single
memory document, the voice wake word, and which persona new conversations bind to.
It is created with the account and cannot be created or deleted through the API —
`GET`/`PATCH /assistant`, addressed with no id.

**A persona** (`personas`) is *how the assistant sounds*. Many per user: name,
description, system prompt, preferred name for the user, voice reference, avatar,
character config, enabled flag. A persona owns **no model, no tools, no memory and
no trigger word**. Swapping persona changes who is speaking without changing what
the assistant can do or remember. `GET`/`POST /personas`,
`GET`/`PATCH`/`DELETE /personas/{id}`, `PATCH /personas/{id}/enabled`.

**A sub-agent** (`sub_agents`) is a task-only worker. It has its own model,
provider, tools and reasoning switches, because it runs its own LLM loop — but no
identity: no avatar, no voice, **no memory**, never bound to a conversation, never
shown as the speaker. A `MainAgent` delegates to one by calling it as a tool and
gets a single string back; the user sees only the main agent's account of it.
`GET`/`POST /sub-agents`, `GET`/`PATCH`/`DELETE /sub-agents/{id}`,
`PATCH /sub-agents/{id}/enabled`.

In code (`agents/`), `MainAgent` is constructed as
`MainAgent(assistant, tool_registry, identity=persona)`: `capabilities` is an
`AssistantConfig`, `identity` a `PersonaConfig`. A `SubAgent` is both at once and
passes a single `SubAgentConfig`. Both extend `BaseAgent`, which owns tool
dispatch and approval.

There is no administrator, router, or group discussion mode. Those existed once
and were removed.

## Choosing the persona

A conversation binds to one persona, stored as `conversations.persona_id`. It is
null until the first message, then `agents/selection.py::pick_persona` resolves it
from the user's **enabled** personas, in this fixed order:

1. an explicit override — the `persona_id` on this `chat_request`, or the binding
   the conversation already has (also settable with `PATCH /conversations/{id}`);
2. the user's `assistants.default_persona_id`;
3. the first enabled persona by id, so the same input always gives the same
   answer;
4. otherwise `ValueError` — a user with no enabled persona has no voice, and the
   handler answers `error` with code `NO_PERSONAS`.

An id that names a persona which is not enabled (disabled, deleted, or another
user's) is logged and skipped rather than honoured.

**Nothing scans the message for a trigger word and nothing is picked at random.**
`assistants.trigger_word` is a *voice wake word*: saying it wakes the assistant,
and whichever persona the conversation is bound to answers. It selects nothing. A
new conversation silently adopts the default persona — there is no picker on
new-chat.

The choice is written back to `conversations.persona_id` on the first bind **and on
every later override**, so a per-turn switch survives to the next message and
across a reconnect. Compaction no longer moves the conversation at all, so the
binding it carries is simply the one already on the row (#99).

`POST /personas` and `POST /personas/import` adopt the new persona as the default
when the assistant has none, deleting the default hands it to the oldest remaining
persona, and the user's last persona cannot be deleted — all because step 2 has no
fallback worth relying on.

## The turn loop

`MainAgent.process` runs at most `MAX_TOOL_ROUNDS` — 10 normally, 25 when the
assistant uses deferred tools. Each round calls the model, streams what comes back,
and if the reply contains tool calls, executes them and loops so the model can
react to the results. Running out of rounds emits a visible "stopped after N
rounds" chunk rather than just ending the stream.

Sub-agents run the same shape internally, capped at 10, and return their final
text. Nothing they emit reaches the client directly.

A denied tool ends the loop.

Each tool call is timed around `execute_tool`, and the resulting tool chunk carries
`duration_ms` plus `tool_kind` (`"tool"` or `"sub_agent"`). Both exist because the
chunk is only emitted *after* the call returns: a client can neither measure the
call nor tell a delegation from an ordinary tool call, since a sub-agent is exposed
to the model as a plain function.

## The system prompt

`MainAgent._prepare_messages` assembles it in this order, joined with blank lines:

1. `You are {persona name}.` plus the persona's `system_prompt`, then the user's
   `users.system_prompt`, then the preferred name (the persona's
   `preferred_name` if set, else the user's), then the current time
2. the user's skill names, with an instruction to load one before acting
3. an **Expression** section, only when the persona's `character_config` is a
   VRM model with `vrm.emotion.enabled` (#243): it asks the model to open a
   sentence with `[[emotion:happy]]` (or `sad`, `angry`, `relaxed`, `surprised`,
   `neutral` — the VRM preset expressions) when its feeling changes, to leave a
   sentence untagged when it does not, and never to mention the tags. See
   "The emotion channel" below for what happens to them.
4. a **Recall** section: past conversations and drive files are searchable
   through `recall_regex` (wording) and `recall_semantic` (meaning); use one
   before saying you do not remember, and quote and cite what it returns (#6,
   `retrieval.md`)
5. the deferred-tool protocol, when `assistants.use_deferred_tools` is set
6. the **assistant's** memory, when `assistants.memory_enabled` and it is non-empty
7. the conversation's `compacted_context`, when there is one
8. the available sub-agents and what each is for, built at runtime from the
   injected `SubAgentTool` adapters

A `SubAgent` builds a much smaller one: its own `system_prompt` and nothing else —
no skills list, no memory, no compacted context, no sub-agent guide.

History follows, replayed with the tool-call linkage intact: an assistant message
carries the `tool_calls` it made, a tool message carries the `tool_call_id` it
answers. Dropping that pairing is an API error on OpenAI-compatible providers.

## The emotion channel

A VRM character has a face, and the face needs to know how the persona feels.
The persona says so in its own reply — the Expression block above asks for a
tag at the start of a sentence whose feeling differs from the last — and the
backend takes the tag out before anyone sees it (#243).

The loop asks an `EmotionSource` (`character/emotion_source.py`) two things
about every streamed piece: what text to show, and where in it the feeling
changed. The one source today is `EmotionTagStripper`
(`character/emotion_tags.py`): it consumes every complete `[[emotion:<label>]]`
with a known label and reports a cue `(offset, label)`; a tag split across
chunks is held back until it completes (never more than 22 characters of
delay, and never shown as a partial); an unknown label passes through verbatim,
so a model that invents one is visible rather than silent; `flush()` releases a
dangling partial when the round ends. Cue offsets are into the round's clean
text, **in UTF-16 code units** — what `String.length` means in both clients —
so an emoji before a tag counts as two. A classifier that reads the sentence
instead of tags is the same two methods (#247, Jev), and `agents/main.py` would
not know the difference.

One source per LLM round: a tool call starts a new round, and its offsets
restart at 0, which is also where the handler starts a new assistant message.
The clean text is what accumulates into the assistant message replayed next
round, so the model never sees its own tags come back and learns to echo them.
Each cue leaves as `emotion` / `emotion_at` on the `stream_chunk` whose
`content` starts there (`websocket.md`); the handler collects them per assistant
message into `messages.emotion_cues`, and the history serves them
(`API.md`). `messages.message` and `raw_output` both hold the stripped text —
the cue column is the only record of where the tags stood. The round's tag
counts go to the log at INFO, which is the compliance signal; a by-hand
`integration` test, `tests/test_emotion_compliance.py`, prints where a live
model actually puts its tags (`development.md`).

A pose-graph persona, a persona with no character, and a persona with the
channel switched off get neither the block nor a stripper: their prompt and
their stream are byte-identical to a backend without the channel. Turning a
cue into an expression at the moment that sentence is *spoken* is the clients'
half (#244 desktop, #246 Android).

## Tool access

`assistants.available_tools` is a JSON array of tool names, or null for all of
them; `sub_agents.available_tools` is the same field for a sub-agent's own loop.
Built-in tools ignore it and are always offered.

**Permission is decided by the server, not the client.** `users.tool_policies` is
read once per turn onto `AgentContext`, and `BaseAgent.execute_tool` applies it
before dispatch:

- a stored `deny` returns immediately and never reaches the client;
- a stored `allow` runs without prompting;
- anything else asks the connected client, and that answer can only narrow the
  server's decision;
- with no client attached, an unapproved call is refused rather than run.

A call resolves against the deferred meta-tools (when enabled), then the native
registry, then handler-injected tools such as sub-agent adapters, then tools the
client registered over the socket, then a server-side MCP server.

Besides `conversation_id`, `user_id` and `agent_id`, `execute_tool` injects the
caller's allowlist as `_available_tools`. It is for a built-in tool that reaches
into what a non-built-in one guards — the recall tools include drive passages
only when `drive_read` could run for this caller — and it lives in the arguments
rather than on `AgentContext` because the same context object is handed to
sub-agents, whose allowlist is their own.

`tool_approval_request` keeps an `agent_id` field: it is the id of whoever is
asking — the persona for a `MainAgent`, the sub-agent itself for a `SubAgent` —
which is why it was not renamed to `persona_id`.

## Memory

Memory is **one free-form markdown document per user**, in `assistants.memory`,
injected into the system prompt when `memory_enabled` is set. Personas do not have
memory; neither do sub-agents. Every persona the user speaks as reads and writes
the same document, so it has to stay persona-neutral — the consolidation prompt
says so explicitly.

It is rewritten in the background. `workers/service.py` scans every 60s for
conversations idle past `CONVERSATION_IDLE_THRESHOLD_MINUTES` (default 30) whose
owner's assistant has memory enabled, which actually contain messages, and which
have not been consolidated since they last changed (`conversations.consolidated_at`
null or older than `updated_at`) — oldest first, at most 50 per scan, over an index
on `updated_at`. It queues **one** `ConsolidateMemoryTask` per conversation — the
target is derived from `user_id`, there is no agent id. The outcome goes back on
the row: success stamps `consolidated_at`; a failure (unreachable model, bad
summary model) schedules a retry with doubling backoff from 5 minutes, and after
five failures the conversation is stamped and left alone until it changes again.
Because that state is in the database, a restart loses nothing and a failure no
longer wedges a conversation for the life of the process (#96).
`utils/memory_consolidation.py::consolidate_assistant_memory` feeds the model the
bound persona's system prompt as "session instructions", the current memory, the
conversation's `compacted_context` and its transcript, and stores the result
(capped at 4000 characters). It uses the user's `summary_model`, so nothing
consolidates without one configured.

That consolidation is a read-modify-write on a row shared by the whole user, with
seconds of LLM latency between the read and the write. It is safe only because the
single `db-worker` thread runs one task at a time. Anything that parallelizes it
needs an atomic write first.

Editable from the assistant settings in both clients, and over
`GET`/`PATCH /assistant`.
