# Kurisu Assistant API Documentation

**Base URL:** `http://localhost:15597`

Every endpoint below exists in `kurisuassistant/routers/`. If this file and the
routers disagree, the routers are right and this file is a bug.

## Table of Contents

- [Authentication](#authentication)
- [Health, Version & the Wire Protocol](#health-version--the-wire-protocol)
- [Models](#models)
- [Conversations](#conversations)
- [Messages](#messages)
- [Assistant](#assistant)
- [Personas](#personas)
- [Sub-Agents](#sub-agents)
- [Export & Import Format](#export--import-format)
- [User Profile](#user-profile)
- [Tool Policies](#tool-policies)
- [Images](#images)
- [Text-to-Speech](#text-to-speech)
- [Speech Recognition](#speech-recognition)
- [Tools & MCP Servers](#tools--mcp-servers)
- [Skills](#skills)
- [Face Recognition](#face-recognition)
- [Character Assets](#character-assets)
- [WebSocket](#websocket)
- [Error Responses](#error-responses)

---

## Authentication

All protected endpoints require a JWT bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

HS256. Access tokens last `ACCESS_TOKEN_EXPIRE_MINUTES` (default 60);
refresh tokens last `REFRESH_TOKEN_EXPIRE_DAYS` (default 30).

### POST /login

**Request:** `application/x-www-form-urlencoded` — `username`, `password`.

**Response:** `200 OK`
```json
{
  "access_token": "eyJ0eXAiOiJKV1Qi...",
  "refresh_token": "eyJ0eXAiOiJKV1Qi...",
  "token_type": "bearer"
}
```

**Errors:** `400` incorrect username or password; `429` rate limited per client
address.

---

### POST /register

Create an account. The same transaction also provisions the account's single
`assistants` row and its first persona (named `Assistant`) — without both, the
account can log in but cannot chat.

**Request:** `application/x-www-form-urlencoded` — `username`, `password`.

**Response:** `200 OK` — same token pair as `/login`.

**Errors:** `400` user already exists; `403` registration is closed on this server
(`ALLOW_REGISTRATION`); `429` rate limited.

---

### POST /auth/refresh

**Request:** `application/json`
```json
{"refresh_token": "..."}
```

**Response:** `200 OK` — a new token pair.

**Error:** `401` invalid or expired refresh token, or the user no longer exists.

---

## Health, Version & the Wire Protocol

### GET /health

No authentication.

```json
{"status": "ok", "service": "llm-hub"}
```

### GET /version

No authentication.

```json
{"backend_version": "0.4.0", "wire_protocol": 4}
```

### The `X-Wire-Protocol` header

Clients ship their own `WIRE_PROTOCOL` constant and send it on every REST request.
Sending nothing is allowed (curl, internal tooling). Sending a value that does not
equal the server's is rejected with `426 Upgrade Required`:

```json
{
  "detail": "wire_protocol_mismatch",
  "client_wire_protocol": 3,
  "server_wire_protocol": 4,
  "backend_version": "0.4.0"
}
```

`/health` and `/version` are exempt, so a stale client can still discover why it is
being refused. The WebSocket handshake enforces the same number and closes with
`4426`; see [websocket.md](websocket.md).

---

## Models

### GET /models

**Response:** `200 OK`
```json
{"models": [{"name": "llama3.2:latest", "provider": "ollama"},
            {"name": "gemini-2.0-flash", "provider": "gemini"}]}
```

Ollama models come from the user's `ollama_url`. Gemini, NVIDIA and Poe models are
added only when the user has stored that provider's key. Poe's catalogue also lists
image, video and audio bots; only text-output models that serve chat completions
are offered.

### GET /models/details

```json
{"models": [{"name": "llama3.2:latest", "size": 4109853696, "modified_at": "..."}]}
```

### POST /models/pull

**Request:** `{"name": "llama3.2:latest"}` → `{"status": "ok", "message": "..."}`.

### DELETE /models/{model_name}

`model_name` is a path-style parameter, so a tagged name (`llama3.2:latest`) works
unescaped. → `{"status": "ok", "message": "..."}`.

### POST /models/ensure/{model_name}

Pulls only if the model is not already present. → `{"status": "ok", "message": "..."}`.

### POST /models/validate-key

**Request:** `{"provider": "gemini" | "nvidia" | "poe", "api_key": "..."}`

**Response:** `200 OK` — `{"valid": true, "model_count": 12}` or
`{"valid": false, "error": "..."}`. Always 200; read `valid`.

Gemini and NVIDIA are validated by listing models with the key. Poe's model list is
public, so its key is checked with a one-token chat request for a model that does
not exist: a bad key is refused with 401 before the model is looked up, a good one
gets a 404 and spends nothing. `error` carries the provider's own message
(`Poe: HTTP 401 authentication_error: Incorrect API key provided. …`).

---

## Conversations

### GET /conversations

**Query:** `limit` (default 50), `persona_id` (optional).

With `persona_id`, returns a single-element list holding the **latest conversation
bound to that persona**, or an empty list.

**Response:** `200 OK`
```json
[
  {
    "id": 12,
    "title": "Conversation title",
    "persona_id": 3,
    "created_at": "2026-09-04T10:30:00Z",
    "updated_at": "2026-09-04T11:45:00Z",
    "message_count": 24,
    "last_message": {"content": "…first 100 chars…", "role": "assistant",
                     "created_at": "2026-09-04T11:45:00Z"}
  }
]
```

`message_count` and `last_message` are omitted from the `persona_id` variant.

---

### GET /conversations/{conversation_id}

**Query:** `limit` (default 20), `offset` (default 0).

Messages are fetched newest-first for pagination and returned oldest-first, which
is what makes infinite scroll work.

**Response:** `200 OK`
```json
{
  "id": 12,
  "title": "Conversation title",
  "persona_id": 3,
  "created_at": "2026-09-04T10:30:00Z",
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "Hello",
      "created_at": "2026-09-04T10:30:00Z",
      "has_raw_data": false
    },
    {
      "id": 2,
      "role": "assistant",
      "content": "Hello! How can I help you?",
      "thinking": "The user is greeting me…",
      "name": "Kurisu",
      "persona_id": 3,
      "persona": {"id": 3, "name": "Kurisu", "avatar_uuid": null,
                  "voice_reference": "kurisu_ref"},
      "model_name": "llama3.2:latest",
      "provider_type": "ollama",
      "created_at": "2026-09-04T10:30:05Z",
      "has_raw_data": true
    }
  ],
  "total_messages": 100,
  "offset": 0,
  "limit": 20,
  "has_more": true,
  "compacted_up_to_id": 0,
  "compacted_context": "",
  "system_prompt_token_count": 48
}
```

Optional per-message keys, present only when set: `name`, `images`, `thinking`,
`model_name`, `provider_type`, `tool_args`, `tool_status`, `context_files`,
`persona_id` + `persona`.

There is **no** `frame_id` and **no** `frames` block. Frames were removed in
migration `0caebafdf4cc`; `compacted_context` is the sole summary source.

**Error:** `404` conversation not found (or not the caller's).

---

### PATCH /conversations/{conversation_id}

Update the title, the bound persona, or both. Replaces the old
`POST /conversations/{id}`, which only ever renamed.

**Request:** `application/json` — both fields optional, read through
`model_fields_set`.

| Field | Type | Description |
|---|---|---|
| `title` | string | New title. Empty or whitespace is rejected. |
| `persona_id` | integer or null | Rebind the conversation. **`null` unbinds it**, so the next message falls back to the assistant's default persona. |

**Response:** `200 OK`
```json
{"id": 12, "title": "New title", "persona_id": 3}
```

**Errors:** `400` nothing to update / empty title / that persona is disabled;
`404` conversation or persona not found.

This is what the chat header's per-conversation persona switch calls. The binding
lives in the database rather than in client state, so it survives a reconnect and
applies even if the user switches and then sends nothing.

---

### DELETE /conversations/{conversation_id}

→ `{"message": "Conversation deleted successfully"}`. Messages cascade.

---

## Messages

### GET /messages/{message_id}

```json
{
  "id": 2,
  "role": "assistant",
  "content": "…",
  "conversation_id": 12,
  "created_at": "2026-09-04T10:30:05Z",
  "has_raw_data": true,
  "persona_id": 3
}
```

`images`, `thinking` and `persona_id` appear only when set.

### DELETE /messages/{message_id}

Deletes the message and every later message in the conversation, which is how
conversation branching works.

→ `{"deleted": 5}`

**Error:** `400` the message has already been folded into
`compacted_context` (`id <= compacted_up_to_id`) — deleting it would leave the
summary asserting something with no source.

### GET /messages/{message_id}/raw

```json
{
  "id": 2,
  "raw_input": [{"role": "system", "content": "…"}, {"role": "user", "content": "…"}],
  "raw_output": "Full LLM response text"
}
```

---

## Assistant

Exactly one assistant per user, so it is addressed **with no id** and has no `POST`
and no `DELETE`: it is created at registration and dies with the account. It owns
capability — model, tools, reasoning, memory — plus the voice wake word and the
default persona.

### GET /assistant

Created on demand for an account that predates the split and never got a row.

**Response:** `200 OK`
```json
{
  "id": 1,
  "model_name": "llama3.2:latest",
  "provider_type": "ollama",
  "available_tools": null,
  "think": false,
  "use_deferred_tools": false,
  "memory": "The user prefers concise answers…",
  "memory_enabled": true,
  "trigger_word": "hey kurisu",
  "default_persona_id": 3
}
```

`available_tools: null` means **every tool**.

### PATCH /assistant

Omitted fields are untouched; an explicit `null` clears the column. That
distinction matters for `available_tools` — `null` is the only way back to "every
tool".

| Field | Type | Nullable |
|---|---|---|
| `model_name` | string | yes |
| `provider_type` | string | **no** |
| `available_tools` | string[] | yes (null = every tool) |
| `think` | boolean | **no** |
| `use_deferred_tools` | boolean | **no** |
| `memory` | string | yes |
| `memory_enabled` | boolean | **no** |
| `trigger_word` | string | yes |
| `default_persona_id` | integer | yes |

**Response:** `200 OK` — the updated assistant.

**Errors:** `400` a non-nullable field was sent as `null`, or
`default_persona_id` names a disabled persona; `404` that persona does not exist.

**`trigger_word` is a voice wake word.** Saying it wakes the assistant and the
conversation's bound persona answers. It selects nothing, and personas do not have
one.

---

## Personas

A persona is presentation: a name, a prompt, a voice, a face. It owns **no model,
no tools, no memory and no wake word** — those are the assistant's.

### GET /personas

All of the user's personas, enabled or not, oldest first.

```json
[
  {
    "id": 3,
    "name": "Kurisu",
    "description": "",
    "system_prompt": "You are a neuroscientist…",
    "preferred_name": "Okabe",
    "voice_reference": "kurisu_ref",
    "avatar_uuid": "550e8400-…",
    "character_config": null,
    "enabled": true
  }
]
```

`preferred_name` is what **this persona calls the user**, overriding
`users.preferred_name`.

### POST /personas

**Request:** `application/json`

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string | yes | — |
| `description` | string | no | `""` |
| `system_prompt` | string | no | `""` |
| `preferred_name` | string | no | null |
| `voice_reference` | string | no | null |
| `avatar_uuid` | string | no | null |
| `character_config` | object | no | null |
| `enabled` | boolean | no | `true` |

The first persona a user creates also becomes their `default_persona_id`, so a new
conversation has someone to bind to.

**Errors:** `400` reserved name (`Administrator`, `User`, `App Guide`) or a
duplicate name.

### GET /personas/{persona_id}

→ one persona. `404` if it is not the caller's.

### PATCH /personas/{persona_id}

Every field optional; an explicit `null` clears the column (that is how a voice
reference or avatar is removed). `name`, `description` and `enabled` may not be
null.

**Errors:** `400` reserved or duplicate name, or a non-nullable field sent as null;
`404` not found.

### DELETE /personas/{persona_id}

→ `{"message": "Persona deleted successfully"}`

**Error:** `400` this is the user's **only** persona. Deleting the *default* is
allowed: the FK clears the pointer and the oldest remaining persona takes over,
deterministically.

### PATCH /personas/{persona_id}/enabled

**Request:** `{"enabled": false}` → the updated persona.

**Error:** `400` this is the default persona — make another one the default first.

### GET /personas/{persona_id}/export

Downloads `application/json` with a `Content-Disposition` attachment filename.

```json
{
  "version": 3,
  "kind": "persona",
  "name": "Kurisu",
  "description": "",
  "system_prompt": "…",
  "preferred_name": "Okabe"
}
```

**Media does not travel.** `avatar_uuid`, `voice_reference` and `character_config`
all name files that exist only on the exporting server; every URL inside a
character config is prefixed with that install's persona id. Shipping the
references without the files gives the importing install broken art, and its next
config save runs the asset cleanup, which deletes whatever the config no longer
references.

### POST /personas/import

**Request:** `multipart/form-data` with `file` (must end in `.json`).

Accepts version 3 persona files and legacy version 2 agent exports whose
`agent_type` is `main`; a v2 main agent's model, tools and memory are **dropped**,
because capability belongs to the importing user's own assistant. A name collision
gets a ` (2)` suffix. Importing when the assistant has no default persona adopts
this one.

**Errors:** `400` not `.json`, invalid JSON, unsupported version, or the file
describes a sub-agent.

---

## Sub-Agents

A sub-agent is a task-only worker the assistant delegates to mid-answer. It runs
its own LLM loop, so it carries its own model, tools and reasoning flags — but it
has no identity: no avatar, no voice, **no memory**, never bound to a conversation,
never shown as the speaker.

The old `/agents` prefix is **gone rather than aliased**. A stale client posting
`{"agent_type": "main"}` there would otherwise silently create a sub-agent instead
of the persona it meant; a 404 is the honest answer.

### GET /sub-agents

```json
[
  {
    "id": 7,
    "name": "Web Search",
    "description": "Searches the web and summarises",
    "system_prompt": "…",
    "model_name": null,
    "provider_type": "ollama",
    "available_tools": ["web_search"],
    "think": false,
    "use_deferred_tools": false,
    "enabled": true
  }
]
```

`model_name: null` means the assistant's model; `available_tools: null` means every
tool.

### POST /sub-agents

Same fields as the response, minus `id`. `name` is required; `provider_type`
defaults to `"ollama"`, `enabled` to `true`, the booleans to `false`.

### GET / PATCH / DELETE /sub-agents/{sub_agent_id}

PATCH follows the same omitted-vs-null rule as personas. `name`, `description`,
`provider_type`, `think`, `use_deferred_tools` and `enabled` may not be null;
`model_name` and `available_tools` are clearable.

DELETE → `{"message": "Sub-agent deleted successfully"}`. Nothing references a
sub-agent, so there is nothing to repair.

### PATCH /sub-agents/{sub_agent_id}/enabled

**Request:** `{"enabled": false}` → the updated sub-agent.

### GET /sub-agents/{sub_agent_id}/export

```json
{
  "version": 3,
  "kind": "sub_agent",
  "name": "Web Search",
  "description": "…",
  "system_prompt": "…",
  "model_name": null,
  "provider_type": "ollama",
  "available_tools": ["web_search"],
  "think": false,
  "use_deferred_tools": false
}
```

Everything a sub-agent has travels, `use_deferred_tools` included — the v2 exporter
omitted it, so an import could never restore it.

### POST /sub-agents/import

`multipart/form-data` with `file`. Accepts version 3 sub-agent files and version 2
agent exports whose `agent_type` is `sub`. A v2 **main** agent is a persona and is
refused here rather than quietly turned into a worker.

---

## Export & Import Format

One file format, two kinds, discriminated by `kind`. `EXPORT_VERSION` is **3**;
version **2** (the old single `agents` export, discriminated by `agent_type`) is
still read. Anything else is a `400`.

| `version` | Discriminator | Maps to |
|---|---|---|
| 3 | `kind: "persona"` | a persona |
| 3 | `kind: "sub_agent"` | a sub-agent |
| 2 | `agent_type: "main"` | a persona (model/tools/memory dropped) |
| 2 | `agent_type: "sub"` | a sub-agent |

Posting a file to the wrong endpoint returns a `400` naming the right one.
`trigger_word` has no export at all — it is the assistant's now, not a persona's.

---

## User Profile

### GET /users/me

```json
{
  "username": "admin",
  "system_prompt": "…",
  "preferred_name": "John",
  "agent_avatar_uuid": "660e8400-…",
  "ollama_url": "http://localhost:11434",
  "has_gemini_key": true,
  "has_nvidia_key": false,
  "has_poe_key": false,
  "summary_model": "llama3.2:latest",
  "summary_provider": "ollama",
  "context_size": 8192
}
```

**Provider API keys are write-only** (wire protocol 2). The response reports only
whether one is configured. A client must omit the key from a PATCH unless the user
typed a new one.

`agent_avatar_uuid` survives the persona split as the account-level fallback a
client shows when the answering persona has no avatar of its own.

### PATCH /users/me

**Request:** `application/json`, any subset. Sending no recognised field returns
`{"status": "ok", "message": "No changes"}`.

| Field | Type | Description |
|---|---|---|
| `system_prompt` | string | Prepended to every persona's prompt |
| `preferred_name` | string | What the assistant calls the user, unless the persona overrides it |
| `ollama_url` | string | Ollama API URL |
| `gemini_api_key` | string | Write-only |
| `nvidia_api_key` | string | Write-only |
| `poe_api_key` | string | Write-only |
| `summary_model` | string | Used for compaction **and** memory consolidation |
| `summary_provider` | string | `ollama` \| `gemini` \| `nvidia` \| `poe` |
| `context_size` | integer | Context window used for the 90% compaction trigger |

**Response:** `{"status": "ok", "message": "Profile updated successfully"}`

### PATCH /users/me/avatars

**Request:** `multipart/form-data` with `agent_avatar` (a file). Sending an empty
file clears it.

**Response:** `{"status": "ok", "agent_avatar_uuid": "660e8400-…"}`

**Error:** `400` the file could not be read as an image.

---

## Tool Policies

The server, not the client, is the tool-permission authority. These policies are
read once per turn and applied before dispatch: a stored `deny` never reaches the
client, a stored `allow` skips the approval prompt, and anything else is put to the
connected client — whose answer can only narrow the decision.

### GET /users/me/tool-policies

```json
{"tools": {"read_file": "allow", "run_command": "deny"}}
```

### PUT /users/me/tool-policies

Replace the whole map. **Request:** `{"tools": {"read_file": "allow"}}` →
`{"status": "ok"}`.

**Error:** `400` a value other than `"allow"` or `"deny"`.

### PATCH /users/me/tool-policies

Set or clear one entry.

**Request:** `{"tool_name": "read_file", "policy": "allow"}` — `policy: null`
removes the entry.

**Errors:** `400` missing `tool_name`, or a policy that is not `allow`/`deny`/null.

---

## Images

### POST /images

`multipart/form-data` with `file` → `{"image_uuid": "…", "url": "/images/…"}`.

### GET /images/u/{image_uuid}

User-scoped chat image. Authenticated by header **or** `?token=` query parameter —
the query variant exists only because `<img src>` cannot send a header. Serves
`image/jpeg` with a one-year immutable cache.

### GET /images/{image_uuid}

Public, no authentication. Serves the stored image with a one-year immutable cache.

---

## Text-to-Speech

Proxied to the `universal-voice` service. A `502` with a generic message is
returned when it is unreachable.

### POST /tts

**Request:** `application/json` — `text` (required), `voice`, `language`,
`provider`.

When `voice` names a file in `data/voice_storage/`, that file is uploaded as the
reference audio; otherwise the name is passed through as a preset `voice_id`.

**Response:** `audio/wav`.

### GET /tts/voices

**Query:** `provider` (optional) → `{"voices": [...]}` as reported by
universal-voice.

### POST /tts/check

**Request:** `{"provider": "vixtts"}` → universal-voice's health response, or
`{"ok": false, "message": "…"}` when it cannot be reached.

### GET /tts/models

→ `{"models": [{"id": "vixtts", "type": "tts", …}]}`. Falls back to a static list
(`vixtts`, `gpt-sovits`, `vieneu:turbo`) when universal-voice is unreachable.

There is no `GET /tts/backends`.

---

## Speech Recognition

### POST /asr

**Request:** raw Int16 PCM at 16 kHz mono, `application/octet-stream`.

**Query:** `language`, `model`, `initial_prompt` (all optional).

**Response:** universal-voice's JSON, e.g. `{"text": "transcribed text"}`.

### POST /asr/detect-language

Same body. **Query:** `model`. Returns the service's detection result.

### GET /asr/models

Lists the ASR models available on universal-voice.

---

## Tools & MCP Servers

### GET /tools

```json
{
  "mcp_tools": [ /* flat list of the user's server-side MCP tool schemas */ ],
  "builtin_tools": [ /* native tool schemas, each tagged "built_in": true|false */ ],
  "mcp_servers": { "server-name": [ /* that server's tools */ ] }
}
```

Native tools registered in `tools/__init__.py`: `history_list`, `history_read`,
`history_search`, `get_skill_instructions` — all `built_in`, so they ignore the
`available_tools` allowlist. The deferred meta-tools (`list_tools`,
`search_tools`, `get_tool_schema`, `call_tool`) are created per-session rather than
registered globally, and appear only when `assistants.use_deferred_tools` is set.

### GET /mcp-servers

```json
[
  {
    "id": 1, "name": "web-search", "transport_type": "sse",
    "url": "http://web-search:8000/sse", "command": null, "args": null, "env": null,
    "enabled": true, "location": "server", "created_at": "2026-09-04T10:30:00Z"
  }
]
```

### POST /mcp-servers

| Field | Type | Notes |
|---|---|---|
| `name` | string | unique per user |
| `transport_type` | `"sse"` \| `"stdio"` | |
| `url` | string | required in practice for `sse` |
| `command`, `args`, `env` | string / string[] / object | for `stdio` |
| `location` | `"server"` \| `"client"` | default `"server"` |

**`stdio` + `location: "server"` is refused.** A stdio entry names a command the
host runs, and these rows are user-writable, so honouring one would let any account
execute arbitrary commands inside the API container. Run stdio servers as
`location: "client"`, where the desktop app runs them on the user's own machine.

**Errors:** `409` duplicate name; `422` invalid `transport_type`/`location` or a
server-side stdio server.

### PATCH /mcp-servers/{server_id}

Partial update. The stdio/server-side check is applied to the values the row will
actually hold, not just the ones sent.

**Errors:** `400` the result would be a server-side stdio server; `404` not found.

### DELETE /mcp-servers/{server_id}

→ `{"deleted": true}`.

### POST /mcp-servers/{server_id}/test

Attempts to list the server's tools.

A `location: "client"` server returns
`{"status": "unavailable", "error": "Client-side servers are tested from the desktop app"}`.

Creating, updating or deleting a server invalidates that user's cached MCP
orchestrator.

---

## Skills

### GET /skills

```json
[{"id": 1, "name": "music_player", "instructions": "…", "created_at": "2026-09-04T10:30:00Z"}]
```

### POST /skills

**Request:** `{"name": "music_player", "instructions": "…"}` → the skill object.
**Error:** `409` duplicate name.

### PATCH /skills/{skill_id}

**Request:** `{"name"?: "...", "instructions"?: "..."}` → the updated skill.
**Error:** `404` not found.

### DELETE /skills/{skill_id}

→ `{"deleted": true}`. **Error:** `404` not found.

There is no skill export/import endpoint on the server.

---

## Face Recognition

### GET /faces

```json
[{"id": 1, "name": "John", "photo_count": 3, "created_at": "2026-09-04T10:30:00Z"}]
```

### POST /faces

**Query:** `name`. **Request:** `multipart/form-data` with `photo`.

Detects a face and stores a 512-dimension embedding. Posting a name that already
exists adds the photo to that identity rather than failing.

```json
{"id": 1, "name": "John",
 "photo": {"id": 1, "photo_uuid": "550e8400-…", "url": "/images/550e8400-…"}}
```

**Error:** `400` invalid image format, or no face detected.

### GET /faces/{identity_id}

```json
{
  "id": 1, "name": "John", "created_at": "2026-09-04T10:30:00Z",
  "photos": [{"id": 1, "photo_uuid": "550e8400-…", "url": "/images/550e8400-…",
              "created_at": "2026-09-04T10:30:00Z"}]
}
```

### DELETE /faces/{identity_id}

Deletes the identity, its photos and the files on disk. → `{"status": "deleted"}`.

### POST /faces/{identity_id}/photos

`multipart/form-data` with `photo`. Adds another photo to an existing identity.

```json
{"id": 2, "photo_uuid": "660e8400-…", "url": "/images/660e8400-…"}
```

### DELETE /faces/{identity_id}/photos/{photo_id}

→ `{"status": "deleted"}`.

### GET /faces/{identity_id}/photos/{photo_id}/image

Serves the photo. Authentication required.

---

## Character Assets

Assets live at `data/character_assets/{persona_id}/…`, and the same persona id is
embedded as a URL prefix inside `character_config`. Migration `0dacee9f63b8`
renamed `agents` to `personas` **without re-keying**, precisely so neither the
directories nor those URLs had to be rewritten.

**Every route here requires authentication and checks that the persona belongs to
the caller** — including the two serving routes, which previously did not, so any
persona's assets could be read by walking sequential ids.

### POST /character-assets/upload-base

**Query:** `persona_id` (int), `pose_id` (string). **Request:**
`multipart/form-data` with `file`.

Saved to `{persona_id}/{pose_id}/base.png`; re-uploading overwrites.

```json
{"asset_id": "3/a1b2/base", "image_url": "/character-assets/3/a1b2/base"}
```

### POST /character-assets/compute-patch

**Query:** `persona_id`, `pose_id`, `part` (`left_eye` | `right_eye` | `mouth`),
`index` (int). **Request:** `multipart/form-data` with `keyframe`.

Diffs the keyframe against the pose's base image, crops the changed region and
stores it as `{persona_id}/{pose_id}/{part}_{index}.png`.

```json
{"patch": {"image_url": "/character-assets/3/a1b2/mouth_0", "x": 100, "y": 200,
           "width": 50, "height": 30}}
```

### POST /character-assets/upload-video

**Query:** `persona_id`, `edge_id`. **Request:** `multipart/form-data` with `file`
(`video/mp4` or `video/webm`).

Saved to `{persona_id}/edges/{edge_id}.mp4|.webm`; the other extension is removed.

```json
{"asset_id": "3/edges/e1f2", "video_url": "/character-assets/3/edges/e1f2"}
```

### POST /character-assets/{persona_id}/migrate-ids

**Request:** `{"id_mapping": {"old_id": "new_id"}}`. Renames pose folders and edge
video files on disk. → `{"message": "Migrated N IDs"}`.

### PATCH /character-assets/{persona_id}/character-config

**Request:** the character config object (with `pose_tree`).

Writes it to `personas.character_config` and **cleans up orphaned asset files** —
anything the new config no longer references is deleted. This is why an imported
config pointing at another install's ids is dangerous.

```json
{"message": "Character config updated", "character_config": {...}}
```

### GET /character-assets/{persona_id}/edges/{edge_id}

Serves the transition video (`mp4` or `webm`), `Cache-Control: no-cache`.
Declared before the generic pose route so `edges` is never matched as a `pose_id`.

### GET /character-assets/{persona_id}/{pose_id}/{filename}

Serves a pose asset (base image or patch), `Cache-Control: no-cache`. The
extension is resolved server-side (`.png`, then `.jpg`).

---

## WebSocket

### /ws/chat

The full protocol — handshake, close codes, and every event shape — is documented
in **[websocket.md](websocket.md)**. In brief:

**Authentication:** `Authorization: Bearer <token>`, or a
`kurisu.auth.bearer, <token>` subprotocol pair for browsers. The `?token=` query
parameter was removed in wire protocol 3.

**Wire protocol:** declared with `X-Wire-Protocol` or a `kurisu.wire.<n>`
subprotocol entry; a mismatch closes with `4426` **before** authentication.

**Client → Server:** `chat_request`, `cancel`, `tool_approval_response`,
`tool_call_response`, `client_tools_register`, `compact_context`, `vision_start`,
`vision_frame`, `vision_stop`.

**Server → Client:** `connected`, `stream_chunk`, `tool_approval_request`,
`tool_call_request`, `context_info`, `conversation_switched`, `done`, `error`,
`vision_result`.

`chat_request` takes an optional `persona_id` (a per-turn override that rebinds the
conversation); the old ignored `agent_id` field is not accepted. On `stream_chunk`,
`persona_id`/`persona_name` are set on assistant chunks only, and tool chunks carry
`tool_kind` and `duration_ms`.

The `agent_switch` event no longer exists.

---

## Error Responses

| Status | Meaning |
|---|---|
| 400 | Bad request — invalid input, or a rule the resource enforces (last persona, disabled persona, compacted message) |
| 401 | Unauthorized — invalid or missing token |
| 403 | Forbidden — registration closed |
| 404 | Not found — the resource does not exist, or is not the caller's |
| 409 | Conflict — duplicate name |
| 422 | Unprocessable — request body failed validation |
| 426 | Wire protocol mismatch |
| 429 | Rate limited (login and registration) |
| 500 | Internal error |
| 502 | An upstream service (universal-voice) is unavailable |

```json
{"detail": "Error message describing what went wrong"}
```

An unexpected exception is **never echoed back**. It is logged with its traceback
and a short reference, and the caller gets a generic message carrying that
reference — raw exception text carries failing SQL, internal URLs and server paths.

---

## Notes

### Conversation creation

1. Send `chat_request` over the WebSocket with `conversation_id: null`.
2. The backend creates the conversation, titled from the first 80 characters of
   the message, and binds a persona — the explicit `persona_id` if the client sent
   one, otherwise `assistants.default_persona_id`.
3. Every `stream_chunk` carries the new `conversation_id`; assistant chunks carry
   the `persona_id` and `persona_name`.

### Context compaction

When the estimated context passes 90% of `users.context_size` (default 8192) and
`users.summary_model` is set, the turn is compacted. Compaction **forks**: a new
conversation is created, seeded with the summary as its `compacted_context` and
carrying the persona binding, and `conversation_switched` announces both ids and
the persona. `compact_context` triggers the same path manually.

### Image handling

1. Images are sent as base64 in `chat_request`.
2. They are saved per user under `data/image_storage/` and assigned UUIDs.
3. The UUIDs are stored in the message's `images` column and echoed back on a
   `role: "user"` stream chunk.
4. The base64 originals are passed to the LLM for vision models.
5. Served by `GET /images/u/{uuid}` with a one-year cache.
6. MCP tools returning image content are saved the same way and attached to the
   tool result message.
