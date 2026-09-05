"""Single source of truth for backend version + wire-protocol compatibility.

`__version__` is the human-readable backend release version (semver).

`WIRE_PROTOCOL` is a monotonically increasing integer bumped on **any breaking
change** to the wire format clients depend on (REST request/response shapes,
WebSocket event payloads, headers, auth flow, etc.). Clients ship with their
own `WIRE_PROTOCOL` constant; if the two don't match exactly, the client is
incompatible and must update.

Bumping rules:
- Add an optional field to a response → DO NOT bump.
- Rename / remove a field, change a field's type, change an event name, change
  required-ness, restructure auth handshake → BUMP.
- Bump rarely; treat each bump as a coordinated release across all clients.

Update log (most recent first):
- 4: The agent was split into an assistant and its personas, and the wire
     follows the split. ONE assistant per user owns capability (model,
     provider, tools, think, deferred tools, memory, and the voice wake word
     `trigger_word`); MANY personas own presentation (name, description,
     system prompt, preferred_name, voice_reference, avatar_uuid,
     character_config). Sub-agents stay separate task-only workers and no
     longer carry memory. Breaking changes:
     - The `/agents` REST surface is gone, replaced by separate persona,
       assistant and sub-agent resources. `agent_type`, `is_system` and a
       per-agent `memory`/`trigger_word` no longer exist.
     - `conversations.main_agent_id` is now `persona_id`, and a message's
       `agent_id` is now `persona_id`, in the database and in every REST
       response that carried them.
     - `chat_request`: the ignored `agent_id` field is now an honoured
       `persona_id` — an optional per-turn persona override that rebinds the
       conversation. Clients that still send `agent_id` are silently ignored,
       as before.
     - `stream_chunk`: `agent_id` is now `persona_id`. `persona_id` and
       `persona_name` are set on ASSISTANT chunks only and are null on tool
       chunks, where `name` carries the tool's own label. Additive on the same
       event: `tool_kind` ("tool" | "sub_agent") and `duration_ms` on tool
       chunks — the server measures a tool call after it returns, so a client
       cannot time it or spot a delegation on its own.
     - `conversation_switched`: `agent_id` is now `persona_id`. Compaction
       creates a new conversation and this is how its persona is announced.
     - The `agent_switch` event and its `agent_switch` type are removed. It
       only ever fired once per turn, before the agent ran, always with
       `from_agent_id: null`, and never signalled a sub-agent.
     - `connected` gains `persona_id` (additive): the persona bound to the
       conversation being reported, so a reconnecting client knows who is
       talking before the first chunk.
     - Persona selection no longer scans the message for a trigger word and
       never picks at random. A new conversation silently uses the assistant's
       `default_persona_id`; the trigger word is a voice wake word on the
       assistant and selects nothing.
- 3: The WebSocket no longer accepts the access token as a `?token=` query
     parameter. Clients authenticate the handshake with an
     `Authorization: Bearer` header, or — in a browser context, which cannot set
     headers on a WebSocket — by offering `kurisu.auth.bearer, <token>` as the
     subprotocol. Character asset routes also require authentication now, so a
     client must fetch those with the token attached rather than pointing an
     image or video element straight at the URL.
- 2: `GET /users/me` no longer returns `gemini_api_key` / `nvidia_api_key`.
     They are write-only now; the response carries `has_gemini_key` and
     `has_nvidia_key` booleans instead. Clients must stop pre-filling the key
     field from the profile, and must omit the key from a PATCH unless the user
     typed a new one — an older client would send back what it read and clear
     the stored key.
- 1: Initial wire protocol baseline.
"""

__version__ = "0.4.0"
WIRE_PROTOCOL = 4
