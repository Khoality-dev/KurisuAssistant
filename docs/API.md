# Kurisu Assistant API Documentation

**Base URL:** `http://localhost:15597`

## Table of Contents

- [Authentication](#authentication)
- [Health & Status](#health--status)
- [Chat & LLM](#chat--llm)
- [Conversations](#conversations)
- [Messages](#messages)
- [Agents](#agents)
- [User Profile](#user-profile)
- [Images](#images)
- [Text-to-Speech](#text-to-speech)
- [Speech Recognition](#speech-recognition)
- [Tools & MCP Servers](#tools--mcp-servers)
- [Skills](#skills)
- [Face Recognition](#face-recognition)
- [Character Assets](#character-assets)
- [WebSocket](#websocket)

---

## Authentication

All protected endpoints require a JWT bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

JWT tokens use HS256 with 30-day expiry.

### POST /login

Authenticate user and receive JWT token.

**Request:** `application/x-www-form-urlencoded`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | User's username |
| password | string | Yes | User's password |

**Response:** `200 OK`
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "token_type": "bearer"
}
```

**Error:** `400 Bad Request` — Incorrect username or password

---

### POST /register

Create a new user account.

**Request:** `application/x-www-form-urlencoded`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | Desired username |
| password | string | Yes | Desired password |

**Response:** `200 OK`
```json
{
  "status": "ok"
}
```

**Error:** `400 Bad Request` — User already exists

---

## Health & Status

### GET /health

Health check endpoint (no authentication required).

**Response:** `200 OK`
```json
{
  "status": "ok",
  "service": "llm-hub"
}
```

---

## Chat & LLM

### WebSocket /ws/chat

Real-time streaming chat over WebSocket. See [WebSocket](#websocket) section for full protocol details.

**Authentication:** Query parameter `?token=<JWT>`

**Client → Server:** `chat_request` event with `text`, `model_name`, `conversation_id?`, `agent_id?`, `images?`

**Server → Client:** `stream_chunk` events (sentence-by-sentence), then `done` event.

---

### GET /models

List available LLM models from user's Ollama instance.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "models": ["llama3.2:latest", "mistral:latest", "qwen2.5:7b"]
}
```

---

### GET /models/details

List available models with detailed info.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "models": [
    {"name": "llama3.2:latest", "size": 4109853696, "modified_at": "2025-01-15T10:30:00Z"}
  ]
}
```

---

### POST /models/pull

Pull/download a model from Ollama registry.

**Authentication:** Required

**Request:** `application/json`
```json
{"name": "llama3.2:latest"}
```

**Response:** `200 OK`
```json
{"status": "ok", "message": "Model pulled successfully"}
```

---

### DELETE /models/{model_name}

Delete a downloaded model.

**Authentication:** Required

**Response:** `200 OK`
```json
{"status": "ok", "message": "Model deleted successfully"}
```

---

### POST /models/ensure/{model_name}

Ensure model exists, pulling if necessary.

**Authentication:** Required

**Response:** `200 OK`
```json
{"status": "ok", "message": "Model is available"}
```

---

## Conversations

### GET /conversations

List user's conversations. With `agent_id`, returns the latest conversation containing messages from that agent.

**Authentication:** Required

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Maximum conversations to return |
| agent_id | integer | null | Filter by agent ID (returns latest conversation for that agent) |

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "title": "Conversation Title",
    "created_at": "2025-01-15T10:30:00Z",
    "updated_at": "2025-01-15T11:45:00Z"
  }
]
```

---

### GET /conversations/{conversation_id}

Get conversation details with paginated messages and referenced frame metadata.

**Authentication:** Required

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 20 | Messages per page |
| offset | integer | 0 | Pagination offset (from newest messages) |

**Pagination:** Messages fetched in reverse chronological order, then reversed before return (chronological order in response). Enables infinite scroll.

**Response:** `200 OK`
```json
{
  "id": 1,
  "title": "Conversation Title",
  "created_at": "2025-01-15T10:30:00Z",
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "Hello",
      "frame_id": 1,
      "created_at": "2025-01-15T10:30:00Z",
      "has_raw_data": false
    },
    {
      "id": 2,
      "role": "assistant",
      "content": "Hello! How can I help you?",
      "thinking": "User is greeting me...",
      "name": "Assistant",
      "agent_id": 2,
      "agent": {"id": 2, "name": "Assistant", "avatar_uuid": null, "voice_reference": null},
      "frame_id": 1,
      "created_at": "2025-01-15T10:30:05Z",
      "has_raw_data": true
    }
  ],
  "frames": {
    "1": {
      "id": 1,
      "summary": "User greeted the assistant",
      "created_at": "2025-01-15T10:30:00Z",
      "updated_at": "2025-01-15T10:30:05Z"
    }
  },
  "total_messages": 100,
  "offset": 0,
  "limit": 20,
  "has_more": true
}
```

---

### POST /conversations/{conversation_id}

Update conversation title.

**Authentication:** Required

**Request:** `application/json`
```json
{"title": "New Conversation Title"}
```

**Response:** `200 OK`
```json
{"message": "Conversation title updated successfully"}
```

---

### DELETE /conversations/{conversation_id}

Delete conversation and all its messages.

**Authentication:** Required

**Response:** `200 OK`
```json
{"message": "Conversation deleted successfully"}
```

---

### GET /conversations/{conversation_id}/frames

List all frames in a conversation with metadata.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "frames": [
    {"id": 1, "summary": "Discussion about...", "created_at": "2025-01-15T10:30:00Z", "updated_at": "2025-01-15T11:00:00Z"}
  ]
}
```

**Note:** Frames are session windows. A new frame is created when the user returns after idle time (`FRAME_IDLE_THRESHOLD_MINUTES`, default 30). Old frames are summarized asynchronously if `User.summary_model` is configured.

---

## Messages

### GET /messages/{message_id}

Get a specific message by ID.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "id": 1,
  "role": "user",
  "content": "Message content",
  "conversation_id": 1,
  "created_at": "2025-01-15T10:30:00Z",
  "has_raw_data": false
}
```

---

### DELETE /messages/{message_id}

Delete a message and all subsequent messages in the conversation (enables conversation branching).

**Authentication:** Required

**Response:** `200 OK`
```json
{"deleted": 5}
```

---

### GET /messages/{message_id}/raw

Get raw LLM input/output for a message.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "id": 1,
  "raw_input": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}],
  "raw_output": "Full LLM response text"
}
```

---

## Agents

### GET /agents

List all agents for the current user. Auto-creates default "Administrator" and "Assistant" agents on first call.

**Authentication:** Required

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "name": "Assistant",
    "system_prompt": "You are a helpful assistant",
    "voice_reference": "kurisu_ref",
    "avatar_uuid": "550e8400-...",
    "model_name": "llama3.2:latest",
    "tools": ["play_music", "music_control"],
    "think": false,
    "character_config": null,
    "memory": "User prefers concise answers...",
    "trigger_word": "hey kurisu"
  }
]
```

---

### GET /agents/{agent_id}

Get a specific agent by ID.

**Authentication:** Required

**Response:** `200 OK` — Same format as list item above.

---

### POST /agents

Create a new agent.

**Authentication:** Required

**Request:** `application/json`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Agent name (cannot be "Administrator" or "User") |
| model_name | string | Yes | LLM model for this agent |
| system_prompt | string | No | Agent's system prompt |
| tools | string[] | No | Opt-in tool names |
| think | boolean | No | Enable chain-of-thought (default: false) |
| trigger_word | string | No | Voice activation trigger word |

**Response:** `200 OK` — Agent object

---

### PATCH /agents/{agent_id}

Update an existing agent. Cannot rename Administrator or change its system prompt/tools.

**Authentication:** Required

**Request:** `application/json` — Any subset of fields:

| Field | Type | Description |
|-------|------|-------------|
| name | string | New name |
| system_prompt | string | New system prompt |
| model_name | string | New LLM model |
| tools | string[] | Updated tool list |
| think | boolean | Enable/disable thinking |
| memory | string | Agent memory text |
| trigger_word | string | Voice activation trigger word |

**Response:** `200 OK` — Updated agent object

---

### PATCH /agents/{agent_id}/avatar

Update agent avatar image.

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| avatar | file | Yes | Avatar image file |

**Response:** `200 OK` — Updated agent object

---

### PATCH /agents/{agent_id}/voice

Upload voice reference file for agent TTS synthesis.

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| voice | file | Yes | Audio file (.wav, .mp3, .flac, .ogg) |

**Response:** `200 OK` — Updated agent object

---

### DELETE /agents/{agent_id}

Delete an agent. Cannot delete Administrator.

**Authentication:** Required

**Response:** `200 OK`
```json
{"message": "Agent deleted successfully"}
```

---

### GET /agents/{agent_id}/avatar-candidates

Detect faces from character pose base images and return cropped avatar candidates.

**Authentication:** Required

**Response:** `200 OK`
```json
[
  {"uuid": "550e8400-...", "pose_id": "a1b2", "score": 0.95}
]
```

---

### POST /agents/{agent_id}/avatar-from-uuid

Set agent avatar from an existing image UUID.

**Authentication:** Required

**Request:** `application/json`
```json
{"avatar_uuid": "550e8400-..."}
```

**Response:** `200 OK` — Updated agent object

---

## User Profile

### GET /users/me

Get current user profile.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "username": "admin",
  "system_prompt": "You are a helpful assistant...",
  "preferred_name": "John",
  "user_avatar_uuid": "550e8400-...",
  "agent_avatar_uuid": "660e8400-...",
  "ollama_url": "http://localhost:11434",
  "summary_model": "llama3.2:latest"
}
```

---

### PATCH /users/me

Update user profile text fields.

**Authentication:** Required

**Request:** `application/json`

| Field | Type | Description |
|-------|------|-------------|
| system_prompt | string | Custom system prompt for the LLM |
| preferred_name | string | User's preferred name |
| ollama_url | string | Ollama API URL |
| summary_model | string | Model for frame summarization and memory consolidation |

**Response:** `200 OK`
```json
{"status": "ok", "message": "Profile updated successfully"}
```

---

### PATCH /users/me/avatars

Update user and/or agent avatar images.

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| user_avatar | file | No | User avatar image |
| agent_avatar | file | No | Agent avatar image |

**Response:** `200 OK`
```json
{
  "status": "ok",
  "user_avatar_uuid": "550e8400-...",
  "agent_avatar_uuid": "660e8400-..."
}
```

---

## Images

### POST /images

Upload an image and receive a UUID.

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | file | Yes | Image file to upload |

**Response:** `200 OK`
```json
{
  "image_uuid": "550e8400-...",
  "url": "/images/550e8400-..."
}
```

---

### GET /images/{image_uuid}

Retrieve an uploaded image (public, no auth required).

**Response:** Image file with 1-year cache:
```
Cache-Control: public, max-age=31536000, immutable
```

---

## Text-to-Speech

### POST /tts

Synthesize speech from text.

**Authentication:** Required

**Request:** `application/json`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | Text to synthesize |
| voice | string | No | Voice name from `/tts/voices` |
| language | string | No | Language code (e.g., "en", "ja") |
| provider | string | No | TTS provider (default: `TTS_PROVIDER` env var or "gpt-sovits") |

**Provider-Specific Parameters:**

**GPT-SoVITS:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| max_chunk_length | integer | 200 | Maximum characters per chunk |
| text_split_method | string | "cut5" | Text splitting method |
| batch_size | integer | 20 | Batch size |

**INDEX-TTS:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| emo_audio | string | null | Voice name for emotion reference audio |
| emo_vector | float[8] | null | Emotion vector [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm] |
| emo_text | string | null | Text description for emotion control |
| use_emo_text | boolean | false | Use emotion from text |
| emo_alpha | float | 1.0 | Emotion strength (0.0-1.0) |

**Response:** `200 OK` — Audio file (`audio/wav`)

---

### GET /tts/voices

List available TTS voices (scans `data/voice_storage/`).

**Authentication:** Required

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| provider | string | Filter by TTS provider (optional) |

**Response:** `200 OK`
```json
{"voices": ["ayaka_ref", "kurisu_ref"]}
```

---

### POST /tts/check

Check if a TTS server is reachable.

**Authentication:** Required

**Request:** `application/json`
```json
{"provider": "gpt-sovits"}
```

**Response:** `200 OK` — Server health response

---

### GET /tts/backends

List available TTS backends.

**Authentication:** Required

**Response:** `200 OK`
```json
{"backends": ["gpt-sovits", "index-tts"]}
```

---

## Speech Recognition

### POST /asr

Convert audio to text using faster-whisper (CTranslate2).

**Authentication:** Required

**Request:** Raw Int16 PCM bytes at 16kHz mono (`application/octet-stream`)

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| language | string | Language hint (e.g., "en", "zh") |

**Response:** `200 OK`
```json
{"text": "transcribed text content"}
```

---

## Tools & MCP Servers

### GET /tools

List all available tools (MCP + built-in).

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "mcp_tools": [...],
  "builtin_tools": [...]
}
```

**Built-in tools** (always available): `search_messages`, `get_conversation_info`, `get_frame_summaries`, `get_frame_messages`, `get_skill_instructions`

**Opt-in tools** (added to agent's `tools` array): `play_music`, `music_control`, `get_music_queue`, `route_to_agent`, `route_to_user`, MCP tools

---

### GET /mcp-servers

List configured MCP servers and their status.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "servers": [
    {"name": "web_search", "url": "http://web-search-container:8000", "status": "available"}
  ]
}
```

**Status values:** `configured`, `available`, `unavailable`

---

## Skills

### GET /skills

List user's skills.

**Authentication:** Required

**Response:** `200 OK`
```json
[
  {"id": 1, "name": "Music Player", "instructions": "When the user asks to play music...", "created_at": "2025-01-15T10:30:00Z"}
]
```

---

### POST /skills

Create a new skill (name unique per user).

**Authentication:** Required

**Request:** `application/json`
```json
{"name": "Music Player", "instructions": "When the user asks to play music..."}
```

**Response:** `200 OK` — Skill object

---

### PATCH /skills/{skill_id}

Update a skill.

**Authentication:** Required

**Request:** `application/json`
```json
{"name": "Updated Name", "instructions": "Updated instructions..."}
```

**Response:** `200 OK` — Updated skill object

---

### DELETE /skills/{skill_id}

Delete a skill.

**Authentication:** Required

**Response:** `200 OK`
```json
{"deleted": true}
```

---

## Face Recognition

### GET /faces

List registered face identities with photo counts.

**Authentication:** Required

**Response:** `200 OK`
```json
[
  {"id": 1, "name": "John", "photo_count": 3, "created_at": "2025-01-15T10:30:00Z"}
]
```

---

### POST /faces

Register a new face identity. Detects face in photo, computes 512-dim embedding.

**Authentication:** Required

**Request:** `multipart/form-data` with query param `name`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | query string | Yes | Identity name (unique per user) |
| photo | file | Yes | Photo containing the face |

**Response:** `200 OK`
```json
{
  "id": 1,
  "name": "John",
  "photo": {"id": 1, "photo_uuid": "550e8400-...", "url": "/faces/1/photos/1/image"}
}
```

**Error:** `400 Bad Request` — No face detected in photo

---

### GET /faces/{identity_id}

Get face identity details with all photos.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "id": 1,
  "name": "John",
  "created_at": "2025-01-15T10:30:00Z",
  "photos": [
    {"id": 1, "photo_uuid": "550e8400-...", "url": "/faces/1/photos/1/image", "created_at": "2025-01-15T10:30:00Z"}
  ]
}
```

---

### DELETE /faces/{identity_id}

Delete face identity, all photos, and disk images.

**Authentication:** Required

**Response:** `200 OK`
```json
{"status": "deleted"}
```

---

### POST /faces/{identity_id}/photos

Add additional photo to existing identity.

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| photo | file | Yes | Photo containing the face |

**Response:** `200 OK`
```json
{"id": 2, "photo_uuid": "660e8400-...", "url": "/faces/1/photos/2/image"}
```

---

### DELETE /faces/{identity_id}/photos/{photo_id}

Remove a specific photo from a face identity.

**Authentication:** Required

**Response:** `200 OK`
```json
{"status": "deleted"}
```

---

### GET /faces/{identity_id}/photos/{photo_id}/image

Serve face photo image file.

**Authentication:** Required

**Response:** Image file

---

## Character Assets

### POST /character-assets/upload-base

Upload base portrait image for character animation.

**Authentication:** Required

**Query Parameters:** `agent_id` (int), `pose_id` (string)

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | file | Yes | Base portrait image |

**Response:** `200 OK`
```json
{"asset_id": "2/a1b2/base.png", "image_url": "/character-assets/2/a1b2/base.png"}
```

---

### POST /character-assets/compute-patch

Upload keyframe image and compute diff patch against the pose's base image.

**Authentication:** Required

**Query Parameters:** `agent_id` (int), `pose_id` (string), `part` (left_eye|right_eye|mouth), `index` (int)

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| keyframe | file | Yes | Keyframe image |

**Response:** `200 OK`
```json
{"patch": {"image_url": "/character-assets/2/a1b2/mouth_0.png", "x": 100, "y": 200, "width": 50, "height": 30}}
```

---

### POST /character-assets/upload-video

Upload transition video for an animation edge.

**Authentication:** Required

**Query Parameters:** `agent_id` (int), `edge_id` (string)

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | file | Yes | Video file (mp4 or webm) |

**Response:** `200 OK`
```json
{"asset_id": "2/edges/e1f2.mp4", "video_url": "/character-assets/2/edges/e1f2.mp4"}
```

---

### PATCH /character-assets/{agent_id}/character-config

Update character animation config (pose tree). Auto-cleans up orphaned assets.

**Authentication:** Required

**Request:** `application/json` — Character config with `pose_tree`

**Response:** `200 OK`
```json
{"message": "Character config updated", "character_config": {...}}
```

---

### POST /character-assets/{agent_id}/migrate-ids

Rename asset files/folders on disk to match migrated IDs.

**Authentication:** Required

**Request:** `application/json`
```json
{"id_mapping": {"old_pose_id": "new_pose_id", "old_edge_id": "new_edge_id"}}
```

**Response:** `200 OK`
```json
{"message": "IDs migrated successfully"}
```

---

### GET /character-assets/{agent_id}/{pose_id}/{filename}

Serve pose asset (base or patch image). No authentication, no cache.

**Response:** Image file

---

### GET /character-assets/{agent_id}/edges/{edge_id}

Serve transition video. No authentication, no cache.

**Response:** Video file (mp4 or webm)

---

## WebSocket

### /ws/chat — Main Chat WebSocket

**Authentication:** Query parameter `?token=<JWT>`

Persistent connection for real-time chat, vision, and media control. All events are JSON objects.

#### Client → Server Events

**chat_request** — Send a message
```json
{
  "type": "chat_request",
  "text": "Hello",
  "model_name": "",
  "conversation_id": 1,
  "agent_id": 2,
  "images": ["base64..."]
}
```

**cancel** — Cancel current streaming response
```json
{"type": "cancel"}
```

**tool_approval_response** — Approve/deny a tool execution
```json
{
  "type": "tool_approval_response",
  "approval_id": "abc123",
  "approved": true,
  "modified_args": {}
}
```

**vision_start** — Start vision processing
```json
{"type": "vision_start", "enable_face": true, "enable_pose": false, "enable_hands": false}
```

**vision_frame** — Send webcam frame for processing
```json
{"type": "vision_frame", "frame": "base64_jpeg_data"}
```

**vision_stop** — Stop vision processing
```json
{"type": "vision_stop"}
```

**Media control events:** `media_play` (query), `media_pause`, `media_resume`, `media_skip`, `media_stop`, `media_queue_add` (query), `media_queue_remove` (index), `media_volume` (volume)

#### Server → Client Events

**stream_chunk** — Streaming chat content
```json
{
  "type": "stream_chunk",
  "content": "Hello ",
  "thinking": "",
  "role": "assistant",
  "agent_id": 2,
  "name": "Assistant",
  "voice_reference": "kurisu_ref",
  "conversation_id": 1,
  "frame_id": 1
}
```

**done** — Streaming complete
```json
{"type": "done", "conversation_id": 1, "frame_id": 1}
```

**error** — Error occurred
```json
{"type": "error", "error": "Error message", "code": 500}
```

**agent_switch** — Agent routing change (group mode)
```json
{
  "type": "agent_switch",
  "from_agent_id": 1,
  "from_agent_name": "Assistant",
  "to_agent_id": 3,
  "to_agent_name": "Coder",
  "reason": "Routing to specialized agent"
}
```

**tool_approval_request** — Tool requires user approval
```json
{
  "type": "tool_approval_request",
  "approval_id": "abc123",
  "tool_name": "play_music",
  "tool_args": {"query": "lofi beats"},
  "description": "Play music from YouTube",
  "risk_level": "low"
}
```

**vision_result** — Vision processing results
```json
{
  "type": "vision_result",
  "faces": [{"name": "John", "confidence": 0.95, "bbox": [x, y, w, h]}],
  "gestures": ["wave", "thumbs_up"]
}
```

**Media events:** `media_state` (state, current_track, queue, volume), `media_chunk` (data, chunk_index, is_last, format, sample_rate), `media_error` (error)

#### Reconnection

Chat WebSocket supports replay: `_accumulated_messages` (complete messages) replayed on reconnect. Client filters by conversation ID.

---

## Error Responses

All endpoints may return standard HTTP error responses:

| Status Code | Description |
|-------------|-------------|
| 400 | Bad Request — Invalid input |
| 401 | Unauthorized — Invalid or missing token |
| 404 | Not Found — Resource does not exist |
| 500 | Internal Server Error — Server-side error |

```json
{"detail": "Error message describing what went wrong"}
```

---

## Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| username | string | Unique identifier |
| password | string | Bcrypt-hashed password |
| system_prompt | string | Custom system prompt for the LLM |
| preferred_name | string | User's preferred name |
| user_avatar_uuid | string | UUID of user's avatar image |
| agent_avatar_uuid | string | UUID of default agent avatar |
| ollama_url | string | Ollama API URL |
| summary_model | string | Model for frame summarization and memory consolidation |

### Conversation

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| user_id | integer | Foreign key to User |
| title | string | Conversation title |
| created_at | datetime | Creation timestamp |
| updated_at | datetime | Last update timestamp |

### Frame

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| conversation_id | integer | Foreign key to Conversation |
| summary | string | Auto-generated session summary (nullable) |
| created_at | datetime | Creation timestamp |
| updated_at | datetime | Last update timestamp |

### Message

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| role | string | "user", "assistant", or "tool" |
| message | string | Message content |
| thinking | string | Chain-of-thought reasoning (nullable) |
| raw_input | JSON | Raw LLM input messages (nullable) |
| raw_output | string | Raw LLM response (nullable) |
| name | string | Speaker name (nullable) |
| frame_id | integer | Foreign key to Frame |
| agent_id | integer | Foreign key to Agent (SET NULL on delete) |
| created_at | datetime | Creation timestamp |

### Agent

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| user_id | integer | Foreign key to User |
| name | string | Agent name |
| system_prompt | string | Agent's system prompt |
| voice_reference | string | Voice file name for TTS (nullable) |
| avatar_uuid | string | UUID of agent's avatar image (nullable) |
| model_name | string | LLM model name |
| tools | JSON | Array of opt-in tool names |
| think | boolean | Enable chain-of-thought |
| memory | text | Auto-consolidated agent memory (nullable) |
| trigger_word | string | Voice activation trigger word (nullable) |
| created_at | datetime | Creation timestamp |

### FaceIdentity

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| user_id | integer | Foreign key to User |
| name | string | Identity name (unique per user) |
| created_at | datetime | Creation timestamp |

### FacePhoto

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| identity_id | integer | Foreign key to FaceIdentity (CASCADE) |
| embedding | vector(512) | Face embedding (pgvector) |
| photo_uuid | string | UUID of photo image |
| created_at | datetime | Creation timestamp |

### Skill

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| user_id | integer | Foreign key to User |
| name | string | Skill name (unique per user) |
| instructions | text | Skill instructions injected into agent prompts |
| created_at | datetime | Creation timestamp |

---

## Notes

### Conversation Creation

Conversations are auto-created on first message:

1. Send a `chat_request` via WebSocket with `conversation_id: null`
2. Backend auto-creates conversation and frame
3. First `stream_chunk` event includes the new `conversation_id` and `frame_id`

### Frame Management

Frames are session windows managed automatically:
- New frame created when user returns after idle time (default: 30 minutes)
- Old frames summarized asynchronously if `User.summary_model` is configured
- LLM only sees messages from the current frame
- Built-in tools (`get_frame_summaries`, `get_frame_messages`) let the LLM access past context

### Image Handling

1. Images sent as base64 in `chat_request` WebSocket events
2. Converted to base64 for LLM processing
3. Embedded as `![Image](/images/{uuid})` in stored message content
4. Served publicly via `GET /images/{uuid}` with 1-year cache
