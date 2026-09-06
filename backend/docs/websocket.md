# WebSocket Protocol

One socket, `/ws/chat`, carries everything: chat, tool approval, client-side tool
execution, context compaction and vision. Every frame is a JSON object.
`websocket/events.py` is the source of truth for the shapes below; `parse_event()`
there is the only thing that accepts a client event, and an unknown `type` raises.

Wire protocol **5**. See `version.py` for the changelog.

## Handshake

The client must authenticate **and** declare its wire protocol during the
handshake. Two carriers for each, because a browser cannot set headers on a
WebSocket:

| | Header | Subprotocol entry |
|---|---|---|
| Token | `Authorization: Bearer <token>` | `kurisu.auth.bearer, <token>` (first two entries) |
| Protocol | `X-Wire-Protocol: 5` | `kurisu.wire.5` (any entry) |

Only `kurisu.auth.bearer` is ever echoed back on accept; the browser drops the
connection if the selected subprotocol is not echoed.

The protocol check runs **before authentication**, so a stale client is told to
update whether or not its token is still valid. A mismatch closes with **4426**
(mirroring the HTTP 426 the REST middleware answers with). Saying nothing is still
allowed, exactly as over HTTP, so curl and internal tooling keep working; an
unparsable value counts as a mismatch.

Missing or invalid credentials close with **4001**. A close frame can only be
delivered after the handshake completes, so the server accepts the socket and then
closes it with a reason.

The `?token=` query parameter was removed in protocol 3 and is not accepted.

Sessions are **last-one-wins**: opening a second socket for the same account closes
the earlier one with **4003** (`Session opened elsewhere`).

## Heartbeat

There is no application-level heartbeat. uvicorn pings at the WebSocket protocol
level, configured in `docker-entrypoint.sh`
(`--ws-ping-interval 5 --ws-ping-timeout 5`). The server still tolerates a stale
client sending `{"type": "pong"}` — it is ignored rather than parsed.

## Reconnection

Messages are persisted to the database incrementally, each complete message written
as a role boundary is crossed, so there is no server-side replay. The
`ChatSessionHandler` survives a reconnect (it is keyed by user id and evicted only
when the user's last connection closes), so a dropped client can rejoin a running
turn and receive the remaining chunks live.

`replace_websocket()` swaps the socket and **drops the tools the previous client
registered** — they belonged to that client, and a different one cannot run them.

On every connect and reconnect the server sends `connected` with a state snapshot.
The client loads already-persisted messages from the database and re-enters
streaming mode if a turn is still active.

## Envelope

Every event carries:

| Field | Type | Notes |
|---|---|---|
| `type` | string | the event name |
| `event_id` | string | uuid4, generated if the client omits it |
| `timestamp` | string | ISO-8601 UTC with a `Z` suffix |

## Server → Client

### `connected`

State snapshot on connect/reconnect.

```json
{
  "type": "connected",
  "chat_active": true,
  "conversation_id": 12,
  "persona_id": 3,
  "vision_active": false,
  "vision_config": null
}
```

`persona_id` is the persona bound to `conversation_id`, so a reconnecting client
knows who is talking before the first chunk. It is null when no conversation is in
flight or the conversation has no binding yet. `conversation_id` and `persona_id`
are both null unless a turn is running or has just finished.

### `stream_chunk`

One per content chunk, thinking chunk and completed tool call.

```json
{
  "type": "stream_chunk",
  "content": "Hello ",
  "thinking": null,
  "role": "assistant",
  "persona_id": 3,
  "persona_name": "Kurisu",
  "name": "Kurisu",
  "voice_reference": "kurisu_ref",
  "conversation_id": 12,
  "tool_args": null,
  "tool_status": null,
  "tool_kind": null,
  "duration_ms": null,
  "tool_calls": null,
  "tool_call_id": null,
  "images": null,
  "model_name": "llama3.2:latest",
  "provider_type": "ollama",
  "token_count": 1840
}
```

- `persona_id`, `persona_name` and `voice_reference` are set on **assistant chunks
  only**. On a tool chunk all three are null and `name` carries the tool's own
  label instead — a tool chunk is not the persona speaking.
- `tool_args`, `tool_status` (`"success" | "error" | "denied"`), `tool_kind` and
  `duration_ms` appear on `role: "tool"` chunks. `tool_kind` is `"tool"` or
  `"sub_agent"`; `duration_ms` is wall-clock time for the call. **These two are the
  only source for a sub-agent tag or a tool timing** — the chunk is emitted after
  the call returns, and a sub-agent is exposed to the model as a plain function, so
  a client can derive neither.
- `tool_calls` is set on an assistant chunk that made calls; `tool_call_id` on each
  tool chunk that answers one. The pairing is stored and replayed, because
  OpenAI-compatible providers reject a tool message with no matching call.
- `images` is a list of image UUIDs. A `role: "user"` chunk with only images is
  sent when the user's message carried attachments.
- `token_count` is a running estimate of the context size (word count × 1.3).

### `tool_approval_request`

```json
{
  "type": "tool_approval_request",
  "approval_id": "…uuid4…",
  "tool_name": "read_file",
  "tool_args": {"path": "/tmp/x"},
  "agent_id": 3,
  "name": "Kurisu",
  "description": "Read /tmp/x",
  "execution_location": "backend"
}
```

`agent_id` is deliberately **not** renamed to `persona_id`: it identifies whoever is
asking — the persona for a `MainAgent`, the sub-agent itself for a `SubAgent`.
`execution_location` is `"backend"` or `"frontend"`. The server waits 300s for a
reply and treats a timeout as a denial.

Only calls the server has not already decided reach the client. A stored `deny` in
`users.tool_policies` never produces this event, and a stored `allow` skips it.

### `tool_call_request`

A tool the client registered, forwarded for local execution.

```json
{"type": "tool_call_request", "request_id": "…uuid4…", "tool_name": "fs_read", "tool_args": {}}
```

The server waits 120s for the matching `tool_call_response`.

### `context_info`

Compaction status, and the only thing that reports it. Sent with
`compacting: true` when a summary is being generated and again with
`compacting: false` when it is finished — on **every** exit path, including a
failed or empty summary, because the client shows a spinner until the second one
arrives (#99).

```json
{"type": "context_info", "conversation_id": 12, "compacting": false,
 "compacted_up_to_id": 431, "compacted_context": "…"}
```

Compaction happens **in place**: the conversation keeps its id, its title, its
persona binding and its stored messages. What changes is the row —
`compacted_context` holds the summary and `compacted_up_to_id` moves to the last
message it covers, which is where the next turn starts reading. On a failed
compaction the watermark stays where it was and `compacted_context` is empty.

There is no `conversation_switched`. Compaction used to fork — a second
conversation seeded with the summary — so one thread quietly became several in
the history list while the watermark it wrote (`0`) trimmed nothing (#99).

### `done`

```json
{"type": "done", "conversation_id": 12}
```

### `error`

```json
{"type": "error", "error": "…", "code": "INTERNAL_ERROR"}
```

`code` is a string, not an HTTP status. Emitted values: `INTERNAL_ERROR` (with a
log reference in the message), `QUEUE_FULL`, `NO_PERSONAS`, `NO_MODEL_SELECTED`,
`NO_SUMMARY_MODEL`, `COMPACT_EMPTY`. `CANCELLED`, `TIMEOUT` and `UNAUTHORIZED` are
declared on the dataclass.

An error is a transient notice: nothing is persisted for it, unlike a
`stream_chunk`.

**`NO_MODEL_SELECTED` is not a failure.** `provision_user` cannot pick a model for
a new account, so `assistants.model_name` starts NULL and the account's very first
message has nothing to run on. The check is in `_setup_conversation`, above the
`create_conversation` call, so a rejected message leaves no conversation behind
and nothing is saved; the model is resolved there exactly as the turn would
resolve it (`assistants.model_name`, else this request's `model_name`), so a
client that names its own model is unaffected. Both clients special-case the code
and offer their own way onto the Assistant screen instead of an error — Settings →
Assistant on desktop, a drawer entry on Android, which is why the sentence names
the screen and not a path. A client that does not special-case it still shows
`error`, which answers the question on its own.

### `vision_result`

```json
{"type": "vision_result", "faces": [], "gestures": []}
```

## Client → Server

### `chat_request`

```json
{
  "type": "chat_request",
  "text": "Hello",
  "model_name": "",
  "conversation_id": 12,
  "persona_id": 3,
  "images": ["<base64>"],
  "context_files": [{"path": "src/a.ts", "fileName": "a.ts", "startLine": 1, "endLine": 20}]
}
```

`conversation_id: null` creates a conversation, titled from the first 80
characters of `text` — unless the turn is refused for having no model, which is
checked first precisely so that a message nobody can answer leaves no conversation
behind.

`persona_id` is an **optional per-turn override**. Omit it on an ordinary message:
a new conversation silently adopts `assistants.default_persona_id` and an existing
one keeps its binding. Sending it rebinds the conversation, and the binding is
persisted. The old, ignored `agent_id` field is **not** accepted — a client that
still sends it is simply ignored, as before.

`model_name` is only a fallback: `assistants.model_name` wins when it is set. Both
first-party clients send `""` and let the server decide. When neither is set the
turn is refused with `NO_MODEL_SELECTED` rather than run — an empty string counts
as unset, since that is what the clients actually send.

A `chat_request` that arrives while a turn is running is **queued**, not
cancelled; the queue is merged into a single follow-up turn. Past 20 queued
messages the client gets `error` with code `QUEUE_FULL`.

### `cancel`

```json
{"type": "cancel"}
```

Clears the queue and cancels the running task.

### `tool_approval_response`

```json
{"type": "tool_approval_response", "approval_id": "…", "approved": true, "modified_args": null}
```

### `tool_call_response`

```json
{"type": "tool_call_response", "request_id": "…", "content": "…", "is_error": false}
```

### `client_tools_register`

```json
{"type": "client_tools_register", "tools": [ /* OpenAI-style function schemas */ ]}
```

Registered per connection and cleared when a new socket replaces this one.

### `compact_context`

```json
{"type": "compact_context", "conversation_id": 12}
```

Manual compaction. Emits `context_info` twice — `compacting: true`, then
`compacting: false` carrying the summary and the new watermark — or an `error`
with `NO_SUMMARY_MODEL` / `COMPACT_EMPTY`, still followed by the closing
`context_info`. An empty conversation is a silent no-op.

### Vision

Start and stop are ordinary JSON events:

```json
{"type": "vision_start", "enable_face": true, "enable_pose": true, "enable_hands": true}
{"type": "vision_stop"}
```

A **frame is a binary message**, not JSON (protocol 6, #111). Pixels in the JSON
path cost a third of the wire to base64, a JSON parse per frame, and — worst — put
a few hundred kilobytes in front of the assistant's next token in the same send
buffer. The envelope:

```
0        1        2                 4              4+H
+--------+--------+-----------------+---------------+------------------+
| version| type   | header length   | header (JSON) | payload (bytes)  |
| uint8  | uint8  | uint16 big-end. | UTF-8, H long | JPEG             |
+--------+--------+-----------------+---------------+------------------+
```

- `version` — `1`, the envelope's own version (`BINARY_PROTOCOL_VERSION`). It is
  not the wire protocol: the handshake already gates that, and this byte lets a
  message type be added later without a connection-wide bump.
- `type` — `1` = vision frame. Nothing else yet.
- `header` — the JSON object carrying what the old event carried besides the
  image: `event_id` and `timestamp`, both optional. At most 4096 bytes.
- `payload` — the JPEG itself. The whole message is capped at 4 MiB.

A malformed or over-long message is answered with `error` (`BAD_BINARY_MESSAGE`)
and the socket stays open — a bad frame is not a reason to drop a conversation.
Backpressure is unchanged: the server skips a frame while inference is still
running, and the client refills on each `vision_result`.

## Removed

- `agent_switch` — deleted along with its event type in protocol 4. It only ever
  fired once per turn, before the agent ran, always with `from_agent_id: null`, and
  never signalled a sub-agent.
- `?token=` WebSocket auth — removed in protocol 3.
- `TurnUpdateEvent`, `LLMLogEvent`, `ContextBreakdownEvent`, and media-control
  events (`media_play`, `media_pause`, …) — these were documented but never
  existed.
