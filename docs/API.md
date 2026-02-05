# Kurisu Assistant API Documentation

**Base URL:** `http://localhost:15597`
**Version:** 0.1.0

## Table of Contents

- [Authentication](#authentication)
- [Health & Status](#health--status)
- [Chat & LLM](#chat--llm)
- [Conversations](#conversations)
- [Messages](#messages)
- [User Profile](#user-profile)
- [Images](#images)
- [Text-to-Speech](#text-to-speech)
- [Speech Recognition](#speech-recognition)
- [MCP Servers](#mcp-servers)

---

## Authentication

All protected endpoints require a JWT bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

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

**Error:** `400 Bad Request`
```json
{
  "detail": "Incorrect username or password"
}
```

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

**Errors:**
- `400 Bad Request` - User already exists
- `500 Internal Server Error` - Registration failed

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

### POST /chat

Stream chat responses with the LLM. Returns newline-delimited JSON (NDJSON).

**Authentication:** Required

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | User message content |
| model_name | string | Yes | LLM model to use (e.g., "llama3.2:latest") |
| conversation_id | integer | No | Conversation ID (null = create new) |
| images | file[] | No | Image attachments |

**Response:** `200 OK` - Streaming `application/x-ndjson`

Each line is a JSON object:

```jsonl
{"message": {"role": "assistant", "content": "Hello", "created_at": "2025-01-15T10:30:00"}, "conversation_id": 1, "chunk_id": 1}
{"message": {"role": "assistant", "content": " there!", "created_at": "2025-01-15T10:30:01"}, "conversation_id": 1, "chunk_id": 1}
{"done": true}
```

**Message Fields:**

| Field | Type | Description |
|-------|------|-------------|
| message.role | string | Message role: "assistant" or "tool" |
| message.content | string | Message content (may be partial during streaming) |
| message.thinking | string | (Optional) Chain-of-thought reasoning for models that support it |
| message.created_at | string | ISO 8601 timestamp |
| conversation_id | integer | Conversation ID (auto-created if null was provided) |
| chunk_id | integer | Current chunk ID |

**Final Message:**
```json
{"done": true}
```

**Notes:**
- User messages are saved to the database but NOT streamed to the frontend
- Messages are streamed sentence-by-sentence for real-time display
- Tool call results appear as separate messages with `role: "tool"`

---

### GET /models

List available LLM models.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "models": [
    "llama3.2:latest",
    "mistral:latest",
    "qwen2.5:7b"
  ]
}
```

---

## Conversations

### GET /conversations

List user's conversations.

**Authentication:** Required

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Maximum conversations to return |

**Response:** `200 OK`
```json
[
  {
    "id": 1,
    "title": "Conversation Title",
    "created_at": "2025-01-15T10:30:00",
    "updated_at": "2025-01-15T11:45:00",
    "message_count": 42
  }
]
```

---

### GET /conversations/{conversation_id}

Get conversation details with paginated messages.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| conversation_id | integer | Conversation ID |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Messages per page |
| offset | integer | 0 | Pagination offset (from newest messages) |

**Pagination Behavior:**
- Messages are fetched in reverse chronological order (newest first) with offset/limit
- Results are reversed before returning, so they appear in chronological order
- Example with 100 total messages:
  - `offset=0, limit=50`: Returns messages 51-100 (newest 50)
  - `offset=50, limit=50`: Returns messages 1-50 (older 50)

**Response:** `200 OK`
```json
{
  "id": 1,
  "title": "Conversation Title",
  "created_at": "2025-01-15T10:30:00",
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "Hello",
      "thinking": null,
      "chunk_id": 1,
      "created_at": "2025-01-15T10:30:00"
    },
    {
      "id": 2,
      "role": "assistant",
      "content": "Hello! How can I help you?",
      "thinking": "User is greeting me...",
      "chunk_id": 1,
      "created_at": "2025-01-15T10:30:05"
    }
  ],
  "total_messages": 100,
  "offset": 0,
  "limit": 50,
  "has_more": true
}
```

**Error:** `404 Not Found` - Conversation not found

---

### POST /conversations/{conversation_id}

Update conversation title.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| conversation_id | integer | Conversation ID |

**Request:** `application/json`
```json
{
  "title": "New Conversation Title"
}
```

**Response:** `200 OK`
```json
{
  "message": "Conversation title updated successfully"
}
```

**Errors:**
- `400 Bad Request` - Title is required
- `404 Not Found` - Conversation not found

---

### DELETE /conversations/{conversation_id}

Delete conversation and all its messages.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| conversation_id | integer | Conversation ID |

**Response:** `200 OK`
```json
{
  "message": "Conversation deleted successfully"
}
```

**Error:** `404 Not Found` - Conversation not found

---

### GET /conversations/{conversation_id}/chunks

List all chunks in a conversation.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| conversation_id | integer | Conversation ID |

**Response:** `200 OK`
```json
{
  "chunks": [
    {
      "id": 1,
      "conversation_id": 1,
      "message_count": 25,
      "created_at": "2025-01-15T10:30:00",
      "updated_at": "2025-01-15T11:00:00"
    }
  ]
}
```

**Error:** `404 Not Found` - Conversation not found

---

## Messages

### GET /messages/{message_id}

Get a specific message by ID.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| message_id | integer | Message ID |

**Response:** `200 OK`
```json
{
  "id": 1,
  "role": "user",
  "content": "Message content",
  "thinking": null,
  "conversation_id": 1,
  "chunk_id": 1,
  "created_at": "2025-01-15T10:30:00"
}
```

**Error:** `404 Not Found` - Message not found

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
  "user_avatar_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000"
}
```

**Note:** Avatar UUIDs are `null` if not set.

---

### PATCH /users/me

Update user profile text fields.

**Authentication:** Required

**Request:** `application/json`
```json
{
  "system_prompt": "Custom instructions for the assistant...",
  "preferred_name": "John"
}
```

**Response:** `200 OK`
```json
{
  "status": "ok",
  "message": "Profile updated successfully"
}
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
  "user_avatar_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000"
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
  "image_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "url": "/images/550e8400-e29b-41d4-a716-446655440000"
}
```

---

### GET /images/{image_uuid}

Retrieve an uploaded image (public endpoint).

**Authentication:** Not required

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| image_uuid | string | Image UUID |

**Response:** Image file (`image/jpeg` or `image/png`)

**Headers:**
```
Cache-Control: public, max-age=31536000, immutable
```

**Error:** `404 Not Found` - Image not found

---

## Text-to-Speech

### POST /tts

Synthesize speech from text.

**Authentication:** Required

**Request:** `application/json`
```json
{
  "text": "Hello world",
  "voice": "ayaka_ref",
  "language": "ja",
  "provider": "gpt-sovits"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | Text to synthesize |
| voice | string | No | Voice name from `/tts/voices` |
| language | string | No | Language code (e.g., "en", "ja") |
| provider | string | No | TTS provider (defaults to `TTS_PROVIDER` env var or "gpt-sovits") |

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
| use_random | boolean | false | Enable random sampling |
| max_chunk_length | integer | 200 | Maximum characters per chunk |

**Response:** `200 OK` - Audio file (`audio/wav`)

**Headers:**
```
Content-Disposition: attachment; filename=speech.wav
```

**Error:** `500 Internal Server Error` - TTS synthesis failed

---

### GET /tts/voices

List available TTS voices.

**Authentication:** Required

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| provider | string | TTS provider (optional) |

**Response:** `200 OK`
```json
{
  "voices": ["ayaka_ref", "kurisu_ref", "another_voice"]
}
```

**Note:** Returns voice names from the `reference/` directory without file extensions.

---

### GET /tts/backends

List available TTS backends.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "backends": ["gpt-sovits", "index-tts"]
}
```

---

## Speech Recognition

### POST /asr

Convert audio to text using Whisper.

**Authentication:** Required

**Request:** Binary audio data (`application/octet-stream`)

The audio should be 16-bit PCM at 16kHz sample rate.

**Response:** `200 OK`
```json
{
  "text": "transcribed text content"
}
```

**Error:** `500 Internal Server Error` - ASR processing failed

---

## MCP Servers

### GET /mcp-servers

List configured MCP (Model Context Protocol) servers and their status.

**Authentication:** Required

**Response:** `200 OK`
```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "python",
      "args": ["-m", "mcp_tools.filesystem.main"],
      "status": "available"
    }
  ]
}
```

**Status Values:**
- `configured` - Server is configured but not yet checked
- `available` - Server is running and responding
- `unavailable` - Server is configured but not responding

---

## Error Responses

All endpoints may return standard HTTP error responses:

| Status Code | Description |
|-------------|-------------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Invalid or missing token |
| 404 | Not Found - Resource does not exist |
| 500 | Internal Server Error - Server-side error |

**Error Response Format:**
```json
{
  "detail": "Error message describing what went wrong"
}
```

---

## Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| username | string | Primary key, unique identifier |
| password | string | Bcrypt-hashed password |
| system_prompt | string | Custom system prompt for the LLM |
| preferred_name | string | User's preferred name |
| user_avatar_uuid | string | UUID of user's avatar image |
| agent_avatar_uuid | string | UUID of agent's avatar image |

### Conversation

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| username | string | Foreign key to User |
| title | string | Conversation title |
| created_at | datetime | Creation timestamp |
| updated_at | datetime | Last update timestamp |

### Chunk

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| conversation_id | integer | Foreign key to Conversation |
| created_at | datetime | Creation timestamp |
| updated_at | datetime | Last update timestamp |

### Message

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Primary key |
| role | string | Message role: "user", "assistant", or "tool" |
| username | string | Username (denormalized) |
| message | string | Message content |
| thinking | string | (Optional) Chain-of-thought reasoning |
| chunk_id | integer | Foreign key to Chunk |
| created_at | datetime | Creation timestamp |

---

## Notes

### Conversation Creation

Conversations are **not** created via an explicit API call. Instead:

1. Send a message with `conversation_id=null` to `POST /chat`
2. The backend auto-creates a conversation and chunk
3. The first streaming response includes the new `conversation_id` and `chunk_id`

### Chunk Management

Chunks are managed automatically by the backend:
- Auto-created on first message to a new conversation
- Backend always continues on the latest chunk
- Clients cannot specify which chunk to use (internal implementation detail)

### Image Handling

1. Images uploaded via `POST /chat` are stored with UUID filenames
2. Converted to base64 for LLM processing
3. Embedded as markdown `![Image](/images/{uuid})` in message content
4. Served publicly via `GET /images/{uuid}` with 1-year cache headers

### Streaming Response Best Practices

When consuming the `/chat` endpoint:

1. Read the response line by line
2. Parse each line as JSON
3. Check for `done: true` to know when streaming is complete
4. Handle potential error messages in the stream

**JavaScript Example:**
```javascript
const response = await fetch('/chat', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);

    if (data.done) {
      console.log('Stream complete');
    } else {
      console.log('Message:', data.message.content);
    }
  }
}
```
