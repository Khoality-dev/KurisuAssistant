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
- [Export & Import Format](#export--import-format)
- [User Profile](#user-profile)
- [Images](#images)
- [Drive](#drive)
- [Calendar](#calendar)
- [Text-to-Speech](#text-to-speech)
- [Speech Recognition](#speech-recognition)
- [Tools & MCP Servers](#tools--mcp-servers)
- [Skills](#skills)
- [Tasks](#tasks)
- [Face Recognition](#face-recognition)
- [Character Assets](#character-assets)
- [Notifications](#notifications)
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
address *and* per username (#155); the two are indistinguishable in the response
address.

---

### POST /register

Create an account. The same transaction also provisions the account's single
`assistants` row — without it, the account can log in but cannot chat. No persona
is made: the assistant answers as itself until the user creates one and makes it
the default (#302).

It cannot provision a **model**: which one to use depends on the operator's
providers, and there is nothing to ask at registration. So `model_name` on the new
row is null and the account's first message is refused with `NO_MODEL_SELECTED`
until someone picks one (`PATCH /assistant`).

**Request:** `application/x-www-form-urlencoded` — `username`, `password`.

**Response:** `200 OK` — same token pair as `/login`.

**Errors:** `400` user already exists; `429` rate limited. Anyone who can reach
the server may register; the account is inactive until the operator activates it,
so there is nothing to refuse at this point.

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
{"status": "ok", "service": "kurisuassistant"}
```

### GET /version

No authentication.

```json
{"backend_version": "0.4.0", "wire_protocol": 4}
```

Both clients call it at startup for the wire-protocol gate, and again from their About / Settings → Account rows to show the backend's version beside their own (#257).

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

Both clients read `server_wire_protocol` and `backend_version` out of this body to
show their update screen when a 426 arrives mid-session (#150), so those two keys
are part of the contract. `/health` and `/version` are exempt, so a stale client can still discover why it is
being refused. The WebSocket handshake enforces the same number and closes with
`4426`; see [websocket.md](websocket.md).

---

## Models

### GET /models

**Response:** `200 OK`
```json
{"models": [{"name": "llama3.2:latest", "provider": "ollama"},
            {"name": "gemini-2.0-flash", "provider": "gemini"}],
 "unavailable": []}
```

Ollama models come from the user's `ollama_url`. Gemini, NVIDIA and Poe models are
added only when the user has stored that provider's key. Poe's catalogue also lists
image, video and audio bots; only text-output models that serve chat completions
are offered.

A provider that cannot be reached is listed in `unavailable` as
`{"provider": "ollama", "detail": "The Ollama server is unreachable. … (reference: …)"}`
rather than silently contributing nothing; an empty `models` with an empty
`unavailable` means the providers answered and have no models. When **no**
provider answered the response is `502` with those details joined — an empty
picker used to be the only symptom of a wrong Ollama URL (#151).

Only what the account has stored is asked (#293): with no Ollama URL there are no
Ollama models and no Ollama entry in `unavailable`, and with no key there are
none of that provider's. An account with nothing set gets
`{"models": [], "unavailable": []}`. The Ollama management routes below
(`/models/details`, `/models/pull`, `DELETE /models/{name}`, `/models/ensure/{name}`)
answer `400` with a sentence naming the missing Ollama URL when it is not set.

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

**Query:** `limit` (default 50). Newest first, by `updated_at`.

A conversation carries no persona (#354): who answers is the persona in use for
the whole account (`selected_persona_id` on `/assistant`). The `?persona_id=`
filter is gone with the binding it filtered on.

**Response:** `200 OK`
```json
[
  {
    "id": 12,
    "title": "Conversation title",
    "task_run": false,
    "task_id": null,
    "created_at": "2026-09-04T10:30:00Z",
    "updated_at": "2026-09-04T11:45:00Z",
    "message_count": 24,
    "last_message": {"content": "…first 100 chars…", "role": "assistant",
                     "created_at": "2026-09-04T11:45:00Z"}
  }
]
```

`task_run` is true for a conversation a task run wrote (#352); `task_id` names
the task, and is null once the task is deleted. `GET /conversations/{id}` carries
both too.

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
      "emotion_cues": [{"emotion": "happy", "at": 0}],
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
`model_name`, `provider_type`, `tool_args`, `tool_status`, `tool_kind`,
`duration_ms`, `context_files`, `emotion_cues`, `persona_id` + `persona`.

`persona_id` + `persona` on an assistant message record who spoke: the persona in
use when it was written. They are history, not a binding — the next turn answers
as whoever is in use then (#354).

On a tool message, `tool_kind` (`"tool"` | `"sub_agent"`) and `duration_ms` are what
the live chunk carried, and on a `delegate_task` row `model_name` is the model its
spawned sub-agent ran on (#327).
Rows written before that have none of them.

`emotion_cues` (#243) is where the persona's feeling changed inside an assistant
message, in order: `[{"emotion": "happy", "at": 0}, {"emotion": "sad", "at": 13}]`.
`emotion` is one of the six VRM preset names (`neutral`, `happy`, `angry`, `sad`,
`relaxed`, `surprised`); `at` is an offset into `content` **in UTF-16 code units**
(`String.length` in both clients). It is present only on assistant messages of a
persona whose character is a VRM model with the emotion channel on — the same
messages whose `stream_chunk`s carried `emotion` / `emotion_at`
(`websocket.md`). The tags the model wrote to say so are stripped before anything
is stored: `content` is the clean text, and so is `raw_output` (below) — the cue
list is the only record of where they stood. A reloaded conversation can set the
character's resting face from the last cue of the last assistant message.

There is **no** `frame_id` and **no** `frames` block. Frames were removed in
migration `0caebafdf4cc`; `compacted_context` is the sole summary source.

**Error:** `404` conversation not found (or not the caller's).

---

### PATCH /conversations/{conversation_id}

Rename a conversation. Replaces the old `POST /conversations/{id}`.

**Request:** `application/json`

| Field | Type | Description |
|---|---|---|
| `title` | string | New title. Empty or whitespace is rejected. |

Any other field is a `422`. `persona_id` was accepted here until #354; a
conversation has no persona to change now — switch the account's with
`PATCH /assistant`.

**Response:** `200 OK`
```json
{"id": 12, "title": "New title"}
```

**Errors:** `400` nothing to update / empty title; `404` conversation not found;
`422` an unknown field.

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
  "raw_output": "The assistant text as accumulated, emotion tags already stripped"
}
```

`raw_output` is the assistant's text as the handler accumulated it, which is
**after** the emotion tags were stripped (#243): it equals the message's
`content`, not the bytes the model produced. Where a tag stood is
`emotion_cues` on the message.

---

## Assistant

Exactly one assistant per user, so it is addressed **with no id** and has no `POST`
and no `DELETE`: it is created at registration and dies with the account. It owns
capability — model, tools, reasoning, memory — plus the voice wake word and
`selected_persona_id`: **the persona in use for the whole account** (#354). Every
turn answers as it — in a new conversation or an old one, on every device, in
voice mode — so writing it here is how a user switches persona, everywhere at
once. Null is the assistant itself (#302). It replaced `default_persona_id` in
wire protocol 8 (#334), and the chat path began applying it in wire protocol 9.

### GET /assistant

Created on demand for an account that predates the split and never got a row.

**Response:** `200 OK`
```json
{
  "id": 1,
  "model_name": "llama3.2:latest",
  "provider_type": "ollama",
  "permission_mode": "ask",
  "think": false,
  "use_deferred_tools": false,
  "memory": "The user prefers concise answers…",
  "memory_enabled": true,
  "trigger_word": "hey kurisu",
  "selected_persona_id": 3
}
```

`permission_mode` is the whole of tool permission (#360): `"ask"` (Always ask,
the default — every tool call waits for approval, reads included), `"read_only"`
(a tool that only looks runs, anything else is refused) or `"full"` (everything
runs). Every tool is always offered; there is no tool list. See
[Tools & Skills](tools.md).

`model_name: null` means **no model chosen yet**, the state every account is
registered in. Until it is set, `chat_request` is refused with
`NO_MODEL_SELECTED` — see [WebSocket Protocol](websocket.md).

### PATCH /assistant

Omitted fields are untouched; an explicit `null` clears the column. A field the
route does not know — the removed `available_tools` included — is refused with
`422`.

| Field | Type | Nullable |
|---|---|---|
| `model_name` | string | yes |
| `provider_type` | string | **no** |
| `permission_mode` | `"ask"` \| `"read_only"` \| `"full"` | **no** (`"auto"` is 422) |
| `think` | boolean | **no** |
| `use_deferred_tools` | boolean | **no** |
| `memory` | string | yes |
| `memory_enabled` | boolean | **no** |
| `trigger_word` | string | yes |
| `selected_persona_id` | integer | yes (null = the assistant itself) |

**Response:** `200 OK` — the updated assistant.

**Errors:** `400` a non-nullable field was sent as `null`, or
`selected_persona_id` names a disabled persona; `404` that persona does not exist;
`422` an unknown field or a `permission_mode` outside the three.

**`trigger_word` is a voice wake word.** Saying it wakes the assistant and the
persona in use answers. It selects nothing, and personas do not have
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

#### `character_config`

`null`, or `{"kind": "pose_graph" | "vrm", "pose_tree"?: {...}, "vrm"?: {...}}`
(wire protocol 7, #235). `kind` says which character system the persona shows;
the two members are kept side by side, so a persona can switch back without
uploading anything again. `pose_tree` is the 2D rig the graph editor writes
(`clients/apps/desktop/docs/character.md`); `vrm` is the 3D model's settings,
typed and validated in `kurisuassistant/character/schema.py`, of which `model`
and `clips` are **server-owned** — written by the asset routes; a body must
leave them out, send `null`, or echo the exact shape `GET /personas` returned
(a partial echo is `422`), and whatever it sends, the stored values win.
Migration `3eb07d0e8d1f` stamps every pose-tree row; a legacy row it could not
classify is left as it was, with a warning in the migration log, so a reader can
still meet a config without `kind` and must treat it as unclassifiable — the
desktop reads it as no character, Android as one that needs a newer app.

Both writers (`POST`/`PATCH /personas`, `PATCH /character-assets/{id}/character-config`)
apply a body the same way, a **merge per member**: `kind` is replaced; a member
left out is kept; a member sent as `null` is cleared, and the files it named are
removed after the write. Refused with `422`, nothing written and nothing on disk
touched: no `kind` or an unknown one, a member of the wrong shape, an unknown key
inside `vrm`, a clip id the stored clips do not hold, or a `/character-assets/`
URL under another persona's id. The `detail` names the member and the cause —
`character_config.pose_tree is not the shape the clients write.`,
`character_config.vrm names another persona's assets.` — and the member at fault
may be one the body never sent: a stored member the server can no longer read
has to be cleared (`null`) before any other save goes through. `POST /personas`
accepts only `null` or a config that names no file — the persona has no id yet
for a file to belong to.

A `vrm` body **replaces the whole member** (bar the server-owned `model` and
`clips`): a sub-member it leaves out resets to its default rather than keeping
the stored value, so a writer sends everything it wants kept. `vrm: {}` is the
schema's defaults — no built-in moves and no reactions; the desktop editor
writes its own starting set ("Natural" movement with `idle.idle_motions:
["stretch", "look_around"]`, and the reactions `wave`, `think`, `greet`, #242)
when it first saves the member. A reaction's `play` is a clip
(`{"type": "clip", "clip_id"}`), an expression (`{"type": "expression",
"expression", "weight", "hold_ms"}`) or a built-in move (`{"type": "motion",
"motion": "wave" | "nod" | "think" | "bow" | "stretch" | "look_around"}`) that
needs no uploaded file; `idle.idle_motions` puts built-in moves in the idle
rotation, and an absent list means none. A `face` condition naming `*` means any
face.

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

Creating a persona does not put it in use: `selected_persona_id` changes only
through `PATCH /assistant`, and while it is null every turn is the assistant's own
(#302).

**Errors:** `400` reserved name (`Administrator`, `User`, `App Guide`) or a
duplicate name; `422` a `character_config` without a `kind`, one that is not the
shape the clients write, or one naming any `/character-assets/` URL — a persona
that does not exist yet has no id for an asset to belong to, so send `null` or a
kinded config that names no file and upload after (see Character Assets).

### GET /personas/{persona_id}

→ one persona. `404` if it is not the caller's.

### PATCH /personas/{persona_id}

Every field optional; an explicit `null` clears the column (that is how a voice
reference or avatar is removed). `name`, `description` and `enabled` may not be
null. `character_config` is merged member by member and swept afterwards exactly
as `PATCH /character-assets/{id}/character-config` does (see `character_config`
above); `null` clears it and removes every file the persona owned.

**Errors:** `400` reserved or duplicate name, or a non-nullable field sent as null;
`404` not found; `422` a `character_config` without a `kind`, one the server cannot
classify, or one that names another persona's assets — refused before anything is
written, and the files it no longer references are removed only after the write
(see Character Assets).

### DELETE /personas/{persona_id}

→ `{"message": "Persona deleted successfully"}`

The row goes first, then everything under `data/character_assets/{persona_id}/`
— pose art, patches, transition videos — is removed (#234). A disk failure at
that point never fails the delete: the response is still `200`, a warning is
logged with what was left behind, and the operator's sweep
(`docs/operations.md`) reclaims it. Never a live persona without its assets.

Any persona can be deleted, the last one included (#302). Deleting the one in use
clears the pointer (the FK is `SET NULL`), so every conversation goes back to the
assistant. Its past messages keep their `persona_id` until then too — the FK on
`messages.persona_id` is `SET NULL` as well.

### PATCH /personas/{persona_id}/enabled

**Request:** `{"enabled": false}` → the updated persona.

Disabling the persona in use clears `selected_persona_id`, here and through
`PATCH /personas/{id}` with `enabled: false`: every conversation goes back to the
assistant (#302). Deleting it clears it through the foreign key.

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

**Media does not travel in this file.** `avatar_uuid`, `voice_reference` and
`character_config` all name files that exist only on the exporting server; every
URL inside a character config is prefixed with that install's persona id. Shipping
the references without the files gives the importing install broken art. Saving
such a config is refused (`422`) because its URLs carry another persona's id
(#233). The character travels only in a bundle, below.

**`?character=true`** makes the download a **version 4 bundle** (`application/zip`,
`<name>.zip`, #248): the persona and its character — pose art, transition videos,
the `.vrm` model and its `.vrma` clips. Avatar and voice still stay behind.

```
persona.json                 the v3 fields, "version": 4, and "character"
character/p1/base.png        every file the character config references,
character/p1/mouth_0.png     at the path the store keeps it at
character/edges/e1.mp4
character/vrm/<sha256>.vrm
character/vrma/<clip_id>.vrma
```

```json
{
  "version": 4, "kind": "persona", "name": "Kurisu", "…": "…",
  "character": {
    "config": { "kind": "vrm", "pose_tree": { "…": "…" }, "vrm": { "model": { "url": "/character-assets/{persona_id}/vrm/model", "…": "…" }, "…": "…" } },
    "files": [ { "path": "vrm/<sha256>.vrm", "bytes": 41234567, "sha256": "<sha256>" } ]
  }
}
```

`config` is the stored `character_config`, both members whichever one shows, with
every `/character-assets/{id}/` written as the literal `/character-assets/{persona_id}/`
— the persona it will belong to does not exist yet. Only files the config still
references travel. `character` is `null` for a persona with none. The files are
stored, not deflated (they are already compressed); the bundle is written under the
persona's lock. `409` `unreadable_character` for a stored config the cleanup walker
cannot classify; `500` `character_files_missing` (logged as an error naming the
persona and the files) when the config names a file that is not on disk — the store
contradicting itself, which is surfaced rather than exported without it. The same
`500` answers `GET /personas/{id}/export/size`.

### GET /personas/{persona_id}/export/size

What `?character=true` would carry, before the download (#248):

```json
{ "character": { "kind": "vrm", "files": 3, "bytes": 42123456, "vrm_bytes": 41234567 } }
```

`bytes` is every file the bundle would hold; `vrm_bytes` is the part an import
meters against the importing account's 3D character quota (the model and clips —
pose art is not metered). `{"character": null}` for a persona with no character.

### POST /personas/import

**Request:** `multipart/form-data` with `file` (must end in `.json`).

Accepts version 3 persona files and legacy version 2 agent exports whose
`agent_type` is `main`; a v2 main agent's model, tools and memory are **dropped**,
because capability belongs to the importing user's own assistant. A name collision
gets a ` (2)` suffix. An imported persona is not put in use.

**Errors:** `400` not `.json`, invalid JSON, unsupported version, the file
describes a sub-agent (saved sub-agents are gone, #354), or it is a version 4
manifest (import the `.zip` it came in).

### POST /personas/import/bundle

**Request:** the bundle as the raw body (`Content-Type: application/zip`), streamed
— not multipart (#248). A bundle has no size ceiling of its own: nginx sets none on
this path (`client_max_body_size 0`, `nginx/nginx.conf`), and what it may hold is
bounded file by file below and by the account's quota.

Creates a persona as `POST /personas/import` does, with its character. The bundle
is untrusted input from another install, so nothing in it is taken on its word:

- every listed path must be one the store writes (`{pose}/{name}.png|jpg`,
  `edges/{edge}.mp4|webm`, `vrm/{sha256}.vrm`, `vrma/{8 hex}.vrma`, each segment one
  plain name), within the ceiling for its kind (`CHARACTER_IMAGE_MAX_BYTES`,
  `…_VIDEO_…`, `…_MODEL_…`, `…_CLIP_…`), at most `PERSONA_BUNDLE_MAX_FILES` (4096 —
a guard against a zip whose directory alone would exhaust memory, not a size limit);
- each file is read out bounded by its listed size and must hash to its listed
  sha256 — a model's must also be the sha in its name;
- the model and clips are inspected as an upload is (the same `415` codes), and
  their refs are rebuilt from the bytes — sha, size, spec version, faces; the
  model's filename and a clip's name and loop are kept, cut as an upload cuts them;
- the config goes through the write path a save does (`merge` over those refs,
  schema, clip ids, classification), with the placeholder resolved to the new
  persona's id, so a URL naming any other persona is a `422`;
- the model and clips are metered against `CHARACTER_ASSETS_QUOTA_BYTES` in the
  transaction that creates the persona (`507` `quota`); pose art is not metered.

Only then, under the new persona's lock, are the referenced files moved into
`data/character_assets/{new id}/`. The bundle is staged in the store's own
`.incoming/` and removed on every outcome; a refusal creates no persona and leaves
no file. A failure moving the files takes the new persona back out (`500`).

**Errors:** `400` not a bundle, no `persona.json`, a manifest or file that does not
hold up, a sub-agent file, an unsupported version; `413` over the bundle ceiling or
a file over its kind's; `415` a model or clip that is not one; `422` a config the
write path refuses; `507` over the 3D character quota.

---

## Sub-Agents

There are none to manage (#354). `/sub-agents` and every route under it are gone,
like `/agents` before them: a stale client gets a `404`. The assistant spawns a
sub-agent itself, mid-answer, through its own `delegate_task` tool; it runs on
the assistant's own model and tools and never appears in the API. See
[Agents](agents.md).

---

## Export & Import Format

One file format, discriminated by `kind`. `EXPORT_VERSION` is **3**;
version **2** (the old single `agents` export, discriminated by `agent_type`) is
still read, and version **4** is a persona's `persona.json` inside a bundle
(`?character=true`, read only by `POST /personas/import/bundle`). Anything else is
a `400`.

| `version` | Discriminator | Maps to |
|---|---|---|
| 4 | `kind: "persona"`, in a `.zip` | a persona with its character |
| 3 | `kind: "persona"` | a persona |
| 3 | `kind: "sub_agent"` | refused: saved sub-agents are gone (#354) |
| 2 | `agent_type: "main"` | a persona (model/tools/memory dropped) |
| 2 | `agent_type: "sub"` | refused, as above |

A sub-agent file is recognised and refused with a `400` that says why, rather
than misread as a persona.
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
  "context_size": 8192,
  "timezone": "Europe/Paris",
  "onboarding_pending": false
}
```

`onboarding_pending` (#342) says whether a client should walk this account
through its onboarding — a provider and a model, nothing else (#376): true until a client reports it finished or skipped (`PATCH {"onboarded":
true}`, from any device), and never once the account has a persona (creating or
importing one ends it too). `users.onboarded_at` holds when.

`timezone` is the account's IANA time zone, or null until a client fills it from
its device (both do, once, the first time they find it empty). Task schedules are
read in it (#352); unset is UTC.

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
| `timezone` | string | An IANA time zone such as `Europe/Paris`; `""` or null clears it. Anything else is a `422` naming it |
| `onboarded` | `true` | The onboarding was finished or skipped (#342). Only `true`: anything else is a `422`, so a client cannot make it owed again |

**Response:** `{"status": "ok", "message": "Profile updated successfully"}`

### PATCH /users/me/avatars

**Request:** `multipart/form-data` with `agent_avatar` (a file). Sending an empty
file clears it.

**Response:** `{"status": "ok", "agent_avatar_uuid": "660e8400-…"}`

**Error:** `400` the file could not be read as an image.

---

## Images

Both `GET` routes are authenticated by header **or** `?token=` query parameter —
the query variant exists only because `<img src>` cannot send a header — and both
serve a one-year **`private`** immutable cache. Private because the URLs are
account-scoped: a shared cache holding one would hand it to the next caller.

### POST /images

`multipart/form-data` with `file` → `{"image_uuid": "…", "url": "/images/…"}`.

Stored under the uploader's own directory, so the image is theirs to fetch back
straight away — before any row references it. That is what lets the persona
editor show an avatar that has been uploaded but not yet saved.

### GET /images/u/{image_uuid}

A chat image, from the caller's own directory. `404` if it is not there.

### GET /images/{image_uuid}

An avatar or face photo, served **only to the account it belongs to** (#154). It
was public until then, which put every account avatar, persona avatar and face
photo one UUID away from anyone who could reach the port; UUIDs travel in API
responses, proxy logs and browser history, so they are not secrets.

Ownership is settled two ways. Anything uploaded since #154 lives in its owner's
directory, where the path answers the question. Anything older sits in the flat
store with no owner on disk, so the referencing row decides:
`users.agent_avatar_uuid`, `personas.avatar_uuid`, or a `face_photos.photo_uuid`
under one of the caller's `face_identities`. A flat-store image nothing references is
served to nobody.

**Errors:** `401` no or invalid token. `404` when the image does not exist *or*
is not the caller's — deliberately not `403`, which would confirm that the UUID
names something real.

The check on the way *in* matters as much as the one on the way out.
`personas.avatar_uuid` is a string the client supplies, so `POST /personas` and
`PATCH /personas/{id}` refuse an `avatar_uuid` the caller does not already own
(`400 Unknown image.`). Without that, the fetch check would be self-serving:
attach a UUID overheard from a proxy log to your own persona, and the row would
then make it yours.

---

## Drive

Account-scoped file storage: one tree per account, browsable from every signed-in
client. Bytes come back exactly as they went in — this is the one upload path in
the API that does not re-encode what it stores. `docs/drive.md` covers the model,
the path-safety rule and the limits.

Every route takes the usual bearer token and is scoped to the caller. **A node
belonging to someone else is `404`, never `403`** — telling a caller that an id
exists is the same leak in a smaller envelope.

Everything except `GET /drive/resolve` addresses a node by **id**, not by path.
Nothing here joins caller-supplied text onto a filesystem path.

A node looks like:

```json
{
  "id": 42, "parent_id": 7, "name": "Q3-revenue-notes.md",
  "is_dir": false, "size": 18432, "mime": "text/markdown",
  "checksum": "9f86d0…", "created_at": "…Z", "updated_at": "…Z"
}
```

`mime`, `checksum` and `size` are null/0 for a folder.

### GET /drive/nodes

Children of `?parent_id=`. Omit it for the top of the drive. Folders first, then
name.

**Errors:** `404` no such folder (or not yours), `400` the id names a file.

### GET /drive/nodes/{node_id}

One node.

### GET /drive/resolve?path=/Reports/Q3.md

The one route that takes a path, for deep links and cold starts. Walked segment
by segment against rows, so `..` matches no name and simply does not resolve.

**Errors:** `404` nothing at that path.

### POST /drive/folders

`{"parent_id": 7 | null, "name": "Reports"}` → the new node.

**Errors:** `400` a name that would look like a path (a separator, `.`, `..`, a
null byte, leading/trailing space, over 255 bytes), `404` no such parent, `409`
the name is taken.

### POST /drive/files

The **raw bytes** as the body, with `?name=` required and `?parent_id=` and
`?overwrite=true` optional. Not `multipart/form-data`, deliberately: a handler
declaring an `UploadFile` makes FastAPI call `request.form()` *before* it
resolves dependencies, so the whole body would be parsed and spooled to the
server's disk before the caller was even authenticated — and before the size
ceiling and the quota. An unauthenticated caller could push whatever the proxy
allows onto the filesystem and only then be told `401`.

Streamed to disk as it arrives, so the limits below are enforced before the
upload has been paid for rather than after.

**Errors:** `400` bad name or a parent that is a file, `404` no such parent,
`409` the name is taken (or is a folder), `413` over `DRIVE_MAX_FILE_BYTES`,
`507` over `DRIVE_QUOTA_BYTES` — re-checked inside the write transaction, so
concurrent uploads cannot overshoot it between them.

### GET /drive/files/{node_id}/content

The bytes back, byte-identical. Authenticated by header **or** `?token=`, because
a streamed download in the Electron main process and a `<video src=…>` cannot set
a header.

Served as `Content-Disposition: attachment`, typed `application/octet-stream`,
with `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
`?inline=1` serves the stored type inline **only** for `image/*`, `audio/*`,
`video/*`, `application/pdf` and `text/plain`, minus `image/svg+xml`; anything
else stays an attachment, because an uploaded page served inline would execute on
the API's own origin with the caller's session behind it.

`Range` requests are answered with `206` (Starlette's `FileResponse`).

**Errors:** `401` no token, `404` not yours or gone, `400` the id names a folder.

### PUT /drive/files/{node_id}/content

Replace an existing file's bytes with the raw request body — what the editor's
Save calls. Streamed, like the upload.

**Errors:** `404` not yours or gone, `400` the id names a folder, `413`/`507` as
above.

### PATCH /drive/nodes/{node_id}

`{"name": "…", "parent_id": 7 | null}` — rename, move, or both. Omitting
`parent_id` leaves the node where it is; sending `null` moves it to the top.

**Errors:** `400` bad name, `404` no such node or parent, `409` the name is taken
there, or the move would put a folder inside itself.

### DELETE /drive/nodes/{node_id}

Permanent. A folder takes its whole subtree, and every blob under it. There is no
trash.

**Errors:** `404` not yours or gone.

### GET /drive/usage

`{"used_bytes": …, "quota_bytes": …, "file_count": …, "max_file_bytes": …}` —
what the explorer's quota bar and Settings → Kurisu Drive read.

---

## Calendar

The user's events and reminders (#282; `routers/calendar.py`, `calendar.md`).
Instants are ISO 8601 UTC with a `Z`; an all-day event is a pair of dates. An
entry of another account is `404`, never `403`. Refusals are `400` with the
sentence in `detail` — the same sentences the assistant's calendar tools give.

An entry:

```json
{
  "id": 42,
  "kind": "reminder",
  "title": "Call Mom",
  "notes": null,
  "all_day": false,
  "starts_at": "2026-10-17T02:00:00Z",
  "ends_at": null,
  "start_date": null,
  "end_date": null,
  "done": false,
  "done_at": null,
  "repeat": null,
  "repeat_days": [],
  "repeat_from": null,
  "created_at": "2026-10-13T22:20:00Z",
  "updated_at": "2026-10-13T22:20:00Z"
}
```

A timed event has `starts_at` and `ends_at`; an all-day event has `all_day:
true` and `start_date`/`end_date` (inclusive) instead. Nothing says who put an
entry there.

**A reminder can repeat** (#355): `repeat` is `daily`, `weekdays` (Monday to
Friday) or `weekly`, with the weekly days in `repeat_days` (`mon` … `sun`,
Monday first). Its times keep the wall-clock time of its first, `repeat_from`,
in the account's zone. A repeating reminder is answered **as one of its
times**: `starts_at` is that time and `done`/`done_at` that time's own — the
window lists one item per time, all with the same `id`; `GET` of one entry and
the answer to a create or a change give its first time from the start of the
account's today (the one that has the change, for a change to one time).

### GET /calendar/entries?start=…&end=…

Every entry overlapping `[start, end)` — what a day or week view shows — and
each time of a repeating reminder in it. Both are required (`422` without), the
window must end after it starts and be at most a year (`400`). All-day entries
are matched a day wider on each side; the client places them by their own
dates.

### GET /calendar/upcoming?limit=20

What is still ahead, soonest first: events not yet over (all-day ones until the
end of their last day in the account's zone — `calendar/zone.zone_for`) and reminders not done and not
past, a repeating reminder's next times among them. `limit` 1–100.

### POST /calendar/entries

`{"kind": "event" | "reminder", "title", "notes"?, "all_day"?, "starts_at"?,
"ends_at"?, "start_date"?, "end_date"?, "repeat"?, "repeat_days"?}` → `201` with
the entry. A reminder needs `starts_at`; a timed event with no `ends_at` lasts
an hour; an all-day event with no `end_date` is one day. Only a reminder
repeats, and a weekly repeat needs at least one day (`400`). A repeating
reminder whose first time has already passed today notifies from its next one.

### GET /calendar/entries/{id}

### PATCH /calendar/entries/{id}

Any of `title`, `notes`, `all_day`, `starts_at`, `ends_at`, `start_date`,
`end_date`, `done`, `repeat`, `repeat_days`, `occurrence_at`. Only the fields
sent change, and the result is validated as a whole before anything is written.
Moving a timed event's start without an end keeps its length; moving a reminder
makes it due again. `done` is a reminder's alone (`400` for an event).

On a repeating reminder `starts_at` moves its first time — and so the time of
day of all of them — and `done` needs `occurrence_at`, the time it is about
(`400` without, or for an instant that is not one of its times); the other
times keep theirs. `repeat` changes the repeat, and `repeat: null` stops it,
leaving a one-off reminder: at `starts_at` when sent, else at its latest time
that has come (which does not notify again), else at its first. A one-off
reminder given a `repeat` becomes a series from its own time.

### DELETE /calendar/entries/{id}

`204`.

---

## Text-to-Speech

Served by the speech engines behind the API — one container each, from
published images — through `kurisuassistant/speech/` (#212). Two kinds of
failure, on the synthesis and recognition routes: a request **refused** with a
`400` (a model this server does not run, an unknown preset voice, a language
the engine does not speak, GPT-SoVITS with no reference clip, text that
normalises to nothing) keeps that status and the reason as `detail`; anything
else (unreachable, a timeout, any other status, a failure inside the engine) is
`502` with `The speech service is unavailable. (reference: …)`, the engine's
own text kept in the log. An engine that is not configured at all is a `502`
naming the profile to start, because that is a deployment's choice rather than
an outage.

### POST /tts

**Request:** `application/json` — `text` (required), `voice`, `language`,
`provider`.

When `voice` names a file in `data/voice_storage/`, that file is uploaded as the
reference audio; otherwise the name is passed through as a preset `voice_id`.
Long text is cut into chunks of about 200 characters (paragraphs, then
sentences; a single sentence longer than that goes whole) and synthesized one
chunk at a time; the pieces come back as one file. A chunk the engine refuses
is skipped when there are others, as the engine itself skipped a chunk it could
not say; the whole request is `400` only when nothing could be said. Five
minutes for the whole text, after which it is the `502`.

**Response:** `audio/wav`.

### GET /tts/voices

**Query:** `provider` (optional) → `{"voices": [{"id": "...", "name": "...", "model": "gpt-sovits"}, ...]}`:
each engine's presets as its `GET /voices` reports them (`docs/speech-engine-contract.md`),
with the model that offers them added. A persona's `voice_reference` stores the
`id`, and both clients list the voices by `name` (#214). An engine that cannot be
asked contributes none.

### POST /tts/check

**Request:** `{"provider": "vixtts"}` → `{"ok": true, "message": "…"}` when
that engine answers, `{"ok": false, "message": "…"}` when it cannot be reached.
Never raises.

### GET /tts/models

→ `{"models": [{"id": "vixtts", "type": "tts", …}]}` — the synthesis models
across the engines. `502` when no engine answers, like `/tts/voices`; an empty
list when they are up and serve no TTS model. (A static list of three ids used to be returned as a normal 200, so the
picker offered models that did not exist — #151.)

There is no `GET /tts/backends`.

---

## Speech Recognition

### POST /asr

**Request:** raw Int16 PCM at 16 kHz mono, `application/octet-stream`.

**Query:** `language`, `initial_prompt` (optional). `model` is accepted and
ignored: a recognition container serves the one model it was started with, so
the choice is `ASR_MODEL` on the server. Both clients still send what they have
stored.

**Response:** `{"text", "language"}`. The PCM is wrapped in a WAV header before
it goes to the engine; nothing is re-encoded.

### POST /asr/detect-language

Same body. **Query:** `model` (ignored, as above) and `languages`
(comma-separated; the desktop's routing mode sends the ones it has a model
mapped for). The engine takes no candidate list, so an answer outside that set
is returned as it came and the client falls back to its default model, which is
what it already does for a language it has no mapping for. Returns
`{"language", "confidence"}`.

### GET /asr/models

→ `{"object": "list", "data": [{"id", "object", "type", "name"}]}` — the
recognition models this server runs, and only those: a catalogue that also
listed the synthesis models made the Android client reject the response (#213).
One entry, named by `ASR_MODEL`. No request is made to the engine — the server
knows what it configured — so this cannot come back empty because something was
briefly unreachable. `502` when no recognition engine is configured.

---

## Tools & MCP Servers

### GET /tools

```json
{
  "mcp_tools": [ /* flat list of the user's server-side MCP tool schemas */ ],
  "server_tools": [ /* the server's own tool schemas */ ],
  "mcp_servers": { "server-name": [ /* that server's tools */ ] }
}
```

Every tool in all three carries `read_only` beside `type` and `function`: whether
it only looks, which is what the Read only permission mode runs without asking
(#360). For an MCP tool it is the server's `readOnlyHint` annotation; one without
it is `false`. A connected client's own tools are not listed — they are the
client's, and it shows them itself. `server_tools` was `builtin_tools`, with
`built_in`/`allowed_by_default` flags, before wire protocol 11.

The server's own tools are registered in `tools/__init__.py` (the history, recall,
skill, notification, drive, task and calendar tools; `tools.md` lists which only
look). The deferred meta-tools (`list_tools`,
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

## Tasks

Work the assistant does on its own, now or on a schedule (#352). There is no
create route: the assistant plans tasks with its own tools (`task_start`,
`task_schedule`, …; see `tasks.md`). A task that is not the caller's is a `404`.

### GET /tasks

**Query:** `include_finished` (default `false`): a one-off task that has run is
`finished` and left out unless asked for — the Tasks screen shows what the
assistant will still do, and the run it made is a conversation.

**Response:** `200 OK` — every task, oldest first:
```json
[
  {
    "id": 2,
    "title": "Morning briefing",
    "instructions": "Weather and today's calendar, three lines at most.",
    "status": "scheduled",
    "repeat": "weekdays",
    "timezone": "Europe/Paris",
    "run_at": null,
    "time": "07:30",
    "days": [],
    "every_hours": null,
    "schedule_label": "Weekdays at 07:30 (Europe/Paris)",
    "next_run_at": "2026-10-14T05:30:00Z",
    "last_run_at": "2026-10-13T05:30:00Z",
    "planned_in_conversation_id": 9,
    "created_at": "2026-10-02T08:12:00Z",
    "updated_at": "2026-10-13T05:30:00Z"
  }
]
```

`status` is `waiting_for_approval` (a run waits on the user; `pending_approval`
then holds the call, shaped as below), `running`, `scheduled`, `paused` or
`finished` (a one-off that has run). `pending_approval` is null otherwise. `repeat` is `now`, `once` (with `run_at`, UTC), `daily`,
`weekdays`, `weekly` (with `days`, `mon`…`sun`) or `hourly` (with
`every_hours`); `time` is `HH:MM` in `timezone`. `schedule_label` is the schedule
in a few words, for display.

### GET /tasks/{task_id}

The task as above, plus `runs`: the ten newest, newest first.
```json
"runs": [
  {"id": 21, "status": "failed", "error": "history_list needed approval, and nobody was there to give it. A task can only use tools set to Allow in Settings › Tools.",
   "conversation_id": 40, "started_at": "2026-10-13T05:30:00Z", "finished_at": "2026-10-13T05:30:03Z"}
]
```
`status` is `running`, `waiting_for_approval`, `done`, `failed` (with `error`, a
sentence to show as it is) or `stopped`. `conversation_id` is the conversation
the run wrote.

### GET /tasks/approvals

Tool calls the user's task runs are waiting on them to approve, oldest first. A
schedule's stored Allow/Deny policy is applied before a call ever waits.
```json
[
  {"id": 3, "run_id": 21, "task_id": 2, "task_title": "Morning briefing", "conversation_id": 40,
   "tool_name": "drive_write", "tool_args": {"path": "/notes/today.md"},
   "description": "Write /notes/today.md", "status": "pending",
   "requested_at": "2026-10-14T05:30:02Z", "expires_at": "2026-10-15T05:30:02Z"}
]
```

### POST /tasks/approvals/{approval_id}

**Request:** `{"approved": true, "modified_args": {…}?}`. Approved, the run carries
on with the call (and the changed arguments, when given); denied, the call ends
as denied and the run fails saying so. **Response:** the approval as above.
**Errors:** `404` when it is not the caller's; `409` "This run is no longer
waiting for an answer." — answered already, expired (24 h,
`TASK_APPROVAL_TIMEOUT_SECONDS`), stopped, or cut off by a restart.

### PATCH /tasks/{task_id}

**Request:** any of
```json
{"title": "…", "instructions": "…", "paused": true,
 "schedule": {"repeat": "weekly", "time": "19:00", "days": ["mon", "thu"], "timezone": "Europe/Paris"}}
```
`paused: true` pauses (no next run); `false` resumes. A new `schedule` replaces
the old one (`at` for `once`, `every_hours` for `hourly`) and reschedules; with
no `timezone` it is read in the account's (`users/me` `timezone`, else UTC).
**Response:** the task with its runs. **Errors:** `400` naming the problem — a
time that is not `HH:MM`, an unknown timezone, a `once` time already past — or
"Nothing to update".

### POST /tasks/{task_id}/stop

Stops the run going now. **Response:** `{"stopped": true}`. **Errors:** `409`
"This task is not running."

### DELETE /tasks/{task_id}

Stops the task's run if one is going, then deletes the task and its runs. The
conversations its runs wrote stay. **Response:** `{"message": "Task deleted"}`.

Every change here, and every run starting or ending, sends `tasks_changed` to
the account's open sockets (`websocket.md`).

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

**Uploads are bounded.** The three pose-graph routes below read at most
`CHARACTER_IMAGE_MAX_BYTES` (16 MiB) or `CHARACTER_VIDEO_MAX_BYTES` (32 MiB, the
video) and answer `413` past it, before anything on disk changes. The VRM model and
clips stream instead (below). A size or format refusal from any character route is
`detail: {"code", "message", ...}` rather than a string.

**Every id and file name a request supplies is checked before it is joined onto a
path** — `pose_id`, `edge_id`, `filename`, both sides of a `migrate-ids` mapping —
on upload and on serve alike. Empty, `.`/`..`, a separator, a NUL, or one of the
reserved directory names (`edges`, `.incoming`, `vrm`, `vrma`) is a 400 `Invalid
<name>.`; Starlette percent-decodes path parameters, so `%2e%2e` is `..` here.

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

**Request:** `{"kind": "pose_graph" | "vrm", "pose_tree"?: {...} | null, "vrm"?: {...} | null}`
— the shape under `GET /personas` → `character_config`, and the merge rules there.

Merges the body over the stored config member by member, writes the result, then
**removes the asset files the merged config no longer references** — whichever
`kind` is selected, both members' files are references. The sweep is fail-closed
and runs after the write (`kurisuassistant/character/`, #233): a body without a
recognised `kind`, or whose `/character-assets/` URLs are not under this persona's
id, is refused with `422` and nothing on disk is touched — an imported config
pointing at another install's ids used to empty the directory, and a kind-less
`{"pose_tree": ...}` is what a protocol-6 client saved (#235). "The shape the
clients write" is meant strictly: `pose_tree` an object whose `nodes` and `edges`
are lists of objects, `patches` and `video_urls` lists, every URL a string; `vrm`
an object whose `model` is null or an object with a string `url` and whose `clips`
are such objects — a list or string where an object belongs is refused, not read
as an empty tree (a kind-less `{"pose_tree": null}` used to sweep everything with
a 200). A member sent as `null` *with* a `kind` is the deliberate clear of that
member. A write that fails leaves every file in place, and once the row is written
the sweep never fails the response: a file already gone or a directory an upload
just filled is logged and left for the next save. `.incoming/` (uploads in flight)
and symlinks are never walked. `PATCH /personas/{id}` writes the same column
through the same rules; an explicit `null` there clears the column and removes
every file.

```json
{"message": "Character config updated", "character_config": {"kind": "vrm", "pose_tree": {...}, "vrm": {...}}}
```

The response carries the **merged** config, so a client that sent stale
server-owned references sees what is actually stored.

### The 3D character: `.vrm` models and `.vrma` clips (#236)

A persona holds at most one VRM model, at `{persona_id}/vrm/{sha256}.vrm`
(content-addressed: a replacement is placed beside the old file before its ref is
committed, and the old file is removed after, so a GET always streams the bytes
its `ETag` names; the public URL stays `…/vrm/model`), and any
number of VRMA clips, at `{persona_id}/vrma/{clip_id}.vrma` — in the character
store, not Kurisu Drive (`drive.md` says why). Their refs, `vrm.model` and
`vrm.clips` in `character_config`, are **server-owned**: these routes write them in
the database transaction that accepts the bytes, a config save puts the stored
values back over whatever its body says, and the stored refs are the one source of
truth for what the cleanup keeps, what the ETag is and how much of the quota is used
(`kurisuassistant/character/assets.py`). Any persona may hold a model or clips
whatever its `kind` — uploading does not change what shows.

Uploads are the **raw request body** (`application/octet-stream`), not multipart,
streamed to `{persona_id}/.incoming/` and moved into place under the persona's
lock — a model before its ref is committed (it is content-addressed, so nothing
names it until then), a clip after; a hang-up or a refusal leaves nothing behind,
a persona deleted while its upload streams is a `404`, and every upload first
sweeps part-files older than a day. Each one carries `?sha256=` (lowercase hex, the
client's digest of the body) and is refused `400 digest_mismatch` when the bytes
hash to anything else. Every "commit, then touch the disk" step — these uploads and
deletes, a config save and its sweep, a persona delete — holds a per-persona lock,
so a sweep can never remove a file an upload is placing (`character/locks.py`; the
API is one process).

**Limits** (`docker-compose.yml`): `CHARACTER_MODEL_MAX_BYTES` 100 MiB,
`CHARACTER_CLIP_MAX_BYTES` 16 MiB per file, `413 too_large` with `max_bytes` past
them, checked as the bytes arrive; `CHARACTER_ASSETS_QUOTA_BYTES` 1 GiB per account
across all its personas, `507 quota` with `used_bytes`/`quota_bytes`. Usage is the
sum of the stored refs' `bytes` — replacing a model counts the old one back in, and
pose art is not metered — measured again inside the transaction that records a new
ref, so two uploads that each fit but not together cannot both land. nginx
gives exactly the two streamed uploads (`PUT …/vrm/model`, `PUT …/vrma`, a regex
location) 128M so that the backend's `413`, which names the limit, is the one a
client sees; the rest of `/character-assets/` keeps the server-wide 50M.

**Validation** reads the 12-byte glTF header and the JSON chunk only, bounded
before anything is parsed (`CHARACTER_MODEL_JSON_MAX_BYTES`, 16 MiB, and never past
the end of the file), and parses it in a worker thread. Refusals are `415` with a
`code`: `not_glb` (not a glTF 2.0 binary), `not_vrm` (a 3D file without a `VRM` or
`VRMC_vrm` extension — a Blender `.glb`), `no_humanoid` (no humanoid with hips, so
nothing could move), `bad_json` (the chunk is missing, too large, deeper than the
parser allows, or not JSON), `not_vrma` (a clip without `VRMC_vrm_animation`).

#### PUT /character-assets/{persona_id}/vrm/model

**Query:** `sha256` (required), `filename` (display only, cut to 128 characters).
Uploads or replaces the model. The ref records what the file says about itself:

```json
{
  "model_url": "/character-assets/3/vrm/model",
  "sha256": "9f2c…", "bytes": 19293184, "uploaded_at": "2026-09-22T10:00:00Z",
  "meta": {"spec_version": "1.0", "title": "Kurisu", "authors": ["…"], "license_name": null,
           "license_url": "https://vrm.dev/licenses/1.0/", "avatar_permission": "onlyAuthor",
           "commercial_usage": "personalNonProfit"},
  "character_config": {"kind": "vrm", "vrm": {"model": {"url": "/character-assets/3/vrm/model",
    "sha256": "9f2c…", "bytes": 19293184, "uploaded_at": "…", "filename": "kurisu_v2.vrm",
    "spec_version": "1.0", "expressions": ["neutral", "happy", "angry", "sad", "relaxed", "surprised"]}, "…": "…"}}
}
```

`expressions` lists which of the six emotion presets the model defines — a VRM 0.x
has no `surprised`. `meta` strings are cut to 256 characters; they come from an
untrusted file, so a client renders them as text. A persona with no `vrm` member
gets one with the defaults; one with no config at all becomes `kind: "vrm"`.

#### DELETE /character-assets/{persona_id}/vrm/model

Clears `vrm.model`, then unlinks the file. The rest of the VRM settings stay. `204`,
also when there was no model.

#### PUT /character-assets/{persona_id}/vrma

**Query:** `sha256` (required), `name` (default `animation`), `loop` (default
`false`). Adds a clip; its id is eight hex digits generated here.
→ `{"clip": {"id", "name", "url", "sha256", "bytes", "loop"}, "character_config": {...}}`.

#### PATCH /character-assets/{persona_id}/vrma/{clip_id}

**Request:** `{"name"?: string, "loop"?: boolean}` — the two fields of a clip a user
edits. → the same shape as the upload. `404` for an id the persona does not hold.

#### DELETE /character-assets/{persona_id}/vrma/{clip_id}

Removes the ref, then the file. `409 clip_in_use` while `vrm.idle.idle_clip_ids` or
a reaction still plays it — take it out of those first. `204`.

#### GET /character-assets/{persona_id}/vrm/model · GET /character-assets/{persona_id}/vrma/{clip_id}

`model/gltf-binary`, with `ETag: "<sha256>"` read from the stored ref (never
re-hashed), `Cache-Control: private, max-age=0, must-revalidate` and
`X-Content-Type-Options: nosniff`; a matching `If-None-Match` is `304` with no body,
which is what keeps a second open of the character window from downloading the
model again. `404` when there is no ref or its file is missing. Declared before the
generic pose route. A clip id that is not eight lowercase hex digits is `400`.

#### GET /character-assets/usage

```json
{"used_bytes": 19593184, "quota_bytes": 1073741824, "max_model_bytes": 104857600,
 "max_clip_bytes": 16777216, "per_persona": [{"persona_id": 3, "bytes": 19593184}]}
```

The shape of `GET /drive/usage`, from the stored refs.

### GET /character-assets/{persona_id}/edges/{edge_id}

Serves the transition video (`mp4` or `webm`), `Cache-Control: no-cache`.
Declared before the generic pose route so `edges` is never matched as a `pose_id`.

### GET /character-assets/{persona_id}/{pose_id}/{filename}

Serves a pose asset (base image or patch), `Cache-Control: no-cache`. The
extension is resolved server-side (`.png`, then `.jpg`).

---

## Notifications

The server keeps every notification and its read state; the clients only display
them (#353). Every read below is announced on `/ws/notifications` as
`notifications_read`, so every other device takes it down. A notification of
another account is `404`, never `403`.

### POST /notifications/devices

`{"platform": "android", "fcm_token": "..."}` — register or refresh this phone for push through Firebase Cloud Messaging (#353). A token is one installed app: registering one another account had moves it here. Answers `{"registered": true, "push": <whether the server pushes at all>}`. The app calls it after sign-in and whenever FCM gives it a new token, while its notifications are on.

### DELETE /notifications/devices/{fcm_token}

Stop pushing to this phone — notifications turned off, or signing out. Another account's token is `404`.

What is pushed is a *data* message, high priority, with no `notification` block — the app builds the system notification itself: `{"type": "notification", "id", "source", "sender", "title", "body", "conversation_id", "reminder_id", "created_at", "read_at"}` (every value a string; null is `""`), or `{"type": "notifications_read", "ids": "1,2"}`.

### GET /notifications

`?unread=true` (only unread), `?limit=` (1–100, default 50), `?offset=`. Unread
first, then newest first.

```json
{"notifications": [{"type": "notification", "id": 12, "source": "assistant", "sender": "Kurisu",
  "title": "Laundry", "body": "The machine is done.", "conversation_id": 7, "reminder_id": null,
  "created_at": "2026-10-16T08:02:00Z", "read_at": null}], "unread_count": 1}
```

### POST /notifications/{notification_id}/read

Reads one and returns it. Reading it again changes nothing and announces nothing.

### POST /notifications/read-all

`{"ids": [...], "read_at": "..."}` — what this call read.

### POST /notifications/read-for

`{"conversation_id": 7}` or `{"reminder_id": 5}` — exactly one (`422` otherwise).
Reads every unread notification pointing at what the user just opened; the
clients call it when a conversation is opened, and the calendar when a reminder
is (#282). Answers like `read-all`.

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
`vision_stop`. A vision **frame** is a binary message rather than a JSON event
(protocol 6) — see [websocket.md](websocket.md#vision).

**Server → Client:** `connected`, `stream_chunk`, `tool_approval_request`,
`tool_call_request`, `context_info`, `done`, `error`,
`vision_result`.

`chat_request` names no persona: every turn answers as the persona in use for the
whole account (#354), and a `persona_id` or the older `agent_id` sent by an old
client is ignored. On `stream_chunk`, `persona_id`/`persona_name` are set on
assistant chunks only, and tool chunks carry `tool_kind` and `duration_ms`.

The `agent_switch` event no longer exists.

### /ws/notifications

Notifications on every device of the account (#353): the same handshake and close
codes as `/ws/chat`, but any number per account and none displaces another or the
chat. Server → client only: `notifications_ready` (what is unread, on connect),
`notification` and `notifications_read`. Shapes in
[websocket.md](websocket.md#notifications-wsnotifications).

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
| 429 | Rate limited (login and registration), by client address or by username |
| 500 | Internal error |
| 502 | An upstream service (a speech engine, a model provider) is unavailable, or not configured |

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
2. The backend checks there is a model to run on — `assistants.model_name`, else
   the request's own `model_name`. With neither it answers `error` /
   `NO_MODEL_SELECTED` and stops here, having created nothing.
3. It creates the conversation, titled from the first 80 characters of the
   message. The conversation carries no persona: the turn answers as the persona
   in use for the account, or as the assistant itself when none is (#354).
4. Every `stream_chunk` carries the new `conversation_id`; assistant chunks carry
   the `persona_id` and `persona_name`.

### Context compaction

When the estimated context passes 90% of `users.context_size` (default 8192) and
`users.summary_model` is set, the turn is compacted **in place**: the summary is
written to the conversation's `compacted_context` and `compacted_up_to_id` moves
to the last message it covers, so the next turn sends the summary instead of
those messages. The conversation keeps its id and its history.
`context_info` announces the start and the finish; `compact_context` triggers the
same path manually.

The estimate behind the trigger — and behind the running token counter on
`stream_chunk` — counts message framing, text, thinking, tool arguments and
images (`utils/tokens.py`). It used to be a word count over `content` alone,
which charged nothing for a picture or a tool payload (#99).

### Image handling

1. Images are sent as base64 in `chat_request`.
2. They are saved per user under `data/image_storage/` and assigned UUIDs.
3. The UUIDs are stored in the message's `images` column and echoed back on a
   `role: "user"` stream chunk.
4. The base64 originals are passed to the LLM for vision models.
5. Served by `GET /images/u/{uuid}` with a one-year private cache, to that user only.
6. MCP tools returning image content are saved the same way and attached to the
   tool result message.
