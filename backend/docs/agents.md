# Agents

One assistant per user, presented through an optional persona, spawning
sub-agents when it needs help. They used to be one `agents` table; migration
`0dacee9f63b8_split_persona_from_assistant` took it apart, and #354 dropped the
saved sub-agents and the per-conversation persona binding.

For what this looks like to a user, see the client screens docs — [Android](../../clients/android/docs/screens.md), [Desktop](../../clients/apps/desktop/docs/screens.md) — where the Assistant
and Personas screens are the split made visible.

**The assistant** (`assistants`) is *what the user's assistant can do*. Exactly one
row per user: model, provider, tool allowlist, reasoning switches, the single
memory document, the voice wake word, and the persona in use for the whole account.
It is created with the account and cannot be created or deleted through the API —
`GET`/`PATCH /assistant`, addressed with no id.

**A persona** (`personas`) is *how the assistant sounds*. Many per user: name,
description, system prompt, preferred name for the user, voice reference, avatar,
character config, enabled flag. A persona owns **no model, no tools, no memory and
no trigger word**. Swapping persona changes who is speaking without changing what
the assistant can do or remember. `GET`/`POST /personas`,
`GET`/`PATCH`/`DELETE /personas/{id}`, `PATCH /personas/{id}/enabled`.

**A sub-agent** is a helper the assistant spawns on the spot (#354). There are no
saved sub-agents and nothing to set up: the assistant calls the built-in
`delegate_task` tool with a task, and `agents/sub.py::DelegateTaskTool` runs a fresh
`SubAgent` on the assistant's own `AssistantConfig` — its model, provider, tool
allowlist and reasoning switch, but **not its memory** — and returns the
sub-agent's final text as the tool result. A sub-agent has no persona, is never the
speaker, and the user sees only the assistant's account of what it did. It is not
offered `delegate_task` itself: that tool is injected into the assistant's turn as
an `extra_tool`, not registered, so a helper cannot spawn helpers.

In code (`agents/`), `MainAgent` is constructed as
`MainAgent(assistant, tool_registry, identity=persona)`: `capabilities` is an
`AssistantConfig`, `identity` a `PersonaConfig`. `SubAgent(assistant, tool_registry)`
runs on the same `AssistantConfig` under a fixed worker identity
(`sub.worker_identity()`). Both extend `BaseAgent`, which owns tool dispatch and
approval.

There is no administrator, router, or group discussion mode. Those existed once
and were removed.

## The persona in use

**A persona is optional (#302).** With none, the assistant answers as itself:
`selection.assistant_identity()` is a `PersonaConfig` with no id, the name
`Assistant`, and no prompt, voice or character, so the rest of the turn runs
unchanged and its chunks carry `persona_id: null`. A new account has no persona
and `assistants.selected_persona_id` starts null.

**One persona, or none, is in use for the whole account (#354):**
`assistants.selected_persona_id`. Every turn answers as it — in a new conversation
or an old one, on every device, in voice mode and in a task run.
`agents/selection.py::persona_in_use` resolves it against the user's **enabled**
personas once per turn, inside the turn's setup query; a pointer at a persona that
is not enabled (a race with a disable) is logged and the assistant answers.
Switching is `PATCH /assistant {"selected_persona_id": …}` and applies everywhere
at once; there is no other way to choose.

A conversation is **not** tied to a persona. `conversations` has no persona column,
a `chat_request` cannot name one, and `PATCH /conversations/{id}` takes only a
title (anything else is a 422). Opening an old conversation continues it as the
persona in use now. Each stored assistant message still records who spoke
(`messages.persona_id`) — a record of the past, which the clients use for avatars
and the speaker split, never a binding.

**Nothing scans the message for a trigger word and nothing is picked at random.**
`assistants.trigger_word` is a *voice wake word*: saying it wakes the assistant,
and the persona in use answers. It selects nothing.

Creating or importing a persona does not put it in use; only the user does, with
`PATCH /assistant`. Any persona can be deleted, the last one included, and the one
in use can be disabled: either hands every conversation back to the assistant (the
FK is `SET NULL`; disabling clears the pointer explicitly).

## The turn loop

`MainAgent.process` runs at most `MAX_TOOL_ROUNDS` — 10 normally, 25 when the
assistant uses deferred tools. Each round calls the model, streams what comes back,
and if the reply contains tool calls, executes them and loops so the model can
react to the results. Running out of rounds emits a visible "stopped after N
rounds" chunk rather than just ending the stream.

A spawned sub-agent runs the same shape internally, capped at 10, and returns its
final text. Nothing it emits reaches the client directly.

A denied tool ends the loop.

Each tool call is timed around `execute_tool`, and the resulting tool chunk carries
`duration_ms` plus `tool_kind` (`"tool"` or `"sub_agent"`). Both exist because the
chunk is only emitted *after* the call returns: a client can neither measure the
call nor tell a delegation from an ordinary tool call, since spawning a sub-agent is
exposed to the model as a plain function. A `delegate_task` chunk is
`tool_kind: "sub_agent"` with `model_name` set to the assistant's model.

## The system prompt

`MainAgent._prepare_messages` assembles it in this order, joined with blank lines:

1. `You are {persona name}.` plus the persona's `system_prompt` — or, with no
   persona, `You are the user's personal assistant.` — then the user's
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

There is no sub-agent section: `delegate_task`'s own description says when to use
it. A `SubAgent` builds a much smaller prompt: `sub.SUB_AGENT_PROMPT` (one task,
reply with the result alone, it goes back to the assistant) and the task — no
persona, no skills list, no memory, no compacted context.

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
them; a spawned sub-agent runs under the same list. Built-in tools ignore it and
are always offered, `delegate_task` included.

**Permission is decided by the server, not the client.** `users.tool_policies` is
read once per turn onto `AgentContext`, and `BaseAgent.execute_tool` applies it
before dispatch:

- a stored `deny` returns immediately and never reaches the client;
- a stored `allow` runs without prompting;
- anything else asks the connected client, and that answer can only narrow the
  server's decision;
- with no client attached, an unapproved call is refused rather than run.

A call resolves against the deferred meta-tools (when enabled), then the native
registry, then handler-injected tools (`delegate_task`), then tools the
client registered over the socket, then a server-side MCP server.

Besides `conversation_id`, `user_id` and `agent_id`, `execute_tool` injects the
caller's allowlist as `_available_tools`. It is for a built-in tool that reaches
into what a non-built-in one guards — the recall tools include drive passages
only when `drive_read` could run for this caller — and it lives in the arguments
rather than on `AgentContext` because the same context object is handed to a
spawned sub-agent, which carries its own copy of the list.

`tool_approval_request` keeps an `agent_id` field: it is the id of whoever is
asking — the persona in use for a `MainAgent`, none for a spawned `SubAgent` —
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
current memory, the conversation's `compacted_context` and its transcript — no
persona prompt, since a conversation is not tied to one (#354) — and stores the result
(capped at 4000 characters). It uses the user's `summary_model`, so nothing
consolidates without one configured.

That consolidation is a read-modify-write on a row shared by the whole user, with
seconds of LLM latency between the read and the write. It is safe only because the
single `db-worker` thread runs one task at a time. Anything that parallelizes it
needs an atomic write first.

Editable from the assistant settings in both clients, and over
`GET`/`PATCH /assistant`.
