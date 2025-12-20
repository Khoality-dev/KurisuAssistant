# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining Speech-to-Text (Whisper), Text-to-Speech (GPT-SoVITS), and LLM capabilities (via Ollama). The system uses a microservices architecture orchestrated with Docker Compose.

## Architecture

### Service Structure

The application consists of multiple containerized services:

- **llm-hub** (port 15597): Main FastAPI application handling chat, authentication, and conversation management
- **tts-hub** (port 15598): Text-to-speech synthesis via GPT-SoVITS
- **postgres** (port 5432): PostgreSQL 16 database for persistence
- **ollama** (port 11434): LLM inference server
- **gpt-sovits** (port 9880): Voice synthesis engine
- **open-webui** (port 3000): Optional web UI

### Database Layer Pattern

The codebase uses a **Repository Pattern** with a generic base class:

```
db/
├── models.py          # SQLAlchemy ORM models
├── session.py         # Session management with connection pooling
├── services.py        # High-level business logic (delegates to repositories)
└── repositories/
    ├── base.py        # BaseRepository[T] with generic CRUD
    ├── user.py        # UserRepository
    ├── conversation.py # ConversationRepository
    ├── chunk.py       # ChunkRepository
    └── message.py     # MessageRepository
```

**Key Pattern**: `db/services.py` functions use context managers (`with get_session()`) for automatic transaction handling and delegate to repository classes for database operations.

### LLM Integration Architecture

The LLM integration follows a **clean separation of concerns** with modular components:

```
llm_hub.py (business logic - users, conversations, chunks, DB)
  ├─> context/manager.py (load messages from DB)
  ├─> prompts/builder.py (build system prompts from user preferences)
  ├─> mcp_tools/orchestrator.py (get tools, inject conversation_id)
  └─> llm_adapter.py (pure LLM interface - no DB knowledge)
        └─> llm_providers/ollama_provider.py (LLM API calls)
```

**Key Modules**:

1. **`llm_adapter.py`** - Pure LLM interface (NO business logic)
   - Orchestrates LLM calls with streaming and tool execution
   - NO knowledge of users, conversations, chunks, or database
   - Handles sentence chunking by delimiters (`.`, `\n`, `?`, `:`, `!`, `;`)
   - Delegates to `llm_providers` for actual LLM API calls

2. **`llm_providers/`** - LLM provider abstraction
   - `base.py`: Abstract `BaseLLMProvider` interface
   - `ollama_provider.py`: Ollama implementation
   - `__init__.py`: Factory function `create_llm_provider()`
   - Supports multiple LLM backends (Ollama, OpenAI, etc.)

3. **`context/manager.py`** - Context loading utilities
   - Stateless functions to load chunk messages from database
   - No in-memory caching (context loaded fresh on each request)

4. **`prompts/builder.py`** - System prompt building
   - `load_global_system_prompt()`: Load from `prompts/AGENT.md`
   - `build_system_messages()`: Combine global + user prompts + timestamp + preferred name

5. **`mcp_tools/orchestrator.py`** - MCP tool management
   - Singleton `MCPOrchestrator` for tool caching (30-second TTL)
   - `get_tools()`: Get cached tools
   - `execute_tool_calls()`: Execute tools with conversation_id injection

**Important**: All business logic (context, prompts, user preferences, database) is handled in `llm_hub.py` BEFORE calling `llm_adapter.chat()`. The adapter is a pure LLM communication layer.

### MCP (Model Context Protocol) Integration

MCP tools provide external capabilities to the LLM via the Model Context Protocol:

- `mcp_tools/config.py`: Scans for tool configs and merges them
- `mcp_tools/client.py`: Async wrappers for `list_tools()` and `call_tool()`
- `mcp_tools/orchestrator.py`: Singleton orchestrator with tool caching and execution
- Automatic `conversation_id` injection for context-aware tools

**Context Retrieval Functions** (formerly MCP tools, now in `db/services.py`):
- `retrieve_messages_by_date_range()`: Search messages by date range
- `retrieve_messages_by_regex()`: Search messages by regex pattern
- `get_conversation_summary()`: Get conversation metadata and stats

These are now regular Python functions instead of MCP tools, callable directly from the application code.

Example MCP tool structure (for custom tools):
```
mcp_tools/custom-tool/
├── main.py          # Tool server implementation
├── config.json      # Server configuration
└── requirements.txt # Python dependencies
```

## Development Commands

### Local Development

```bash
# Setup virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Run migrations manually
python migrate.py

# Start server locally
./run_dev.bat  # Windows
```

### Docker Development

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f llm-hub

# Rebuild specific service
docker-compose up -d --build llm-hub

# Stop services
docker-compose down
```

### Database Migrations

Migrations use **Alembic** with automatic execution on container startup via `docker-entrypoint.sh`:

```bash
# Create new migration
cd db
alembic revision --autogenerate -m "description"

# Manual migration run (without Docker)
python migrate.py

# Migration files location
db/alembic/versions/
```

**Important**: The first migration seeds a default `admin:admin` account.

## Key Patterns & Conventions

### Authentication

JWT-based authentication with bcrypt password hashing:

```python
# Token generation (auth/operations.py)
- Algorithm: HS256
- Expiration: 30 days (configurable via ACCESS_TOKEN_EXPIRE_DAYS)
- Secret: JWT_SECRET_KEY environment variable

# Protected endpoints
- Dependency: Depends(get_authenticated_user)
- Returns: username string
- Raises: HTTPException(401) if invalid
```

### Error Logging

Comprehensive error logging is implemented throughout the application using Python's standard `logging` module:

**Logging Configuration**:
- Configured in `llm_hub.py` with `logging.basicConfig(level=logging.INFO)`
- Each module creates its own logger: `logger = logging.getLogger(__name__)`
- Logs include full stack traces via `exc_info=True` for debugging

**Error Logging Locations**:

1. **`llm_hub.py`** - All endpoint errors logged before raising HTTPException:
   - LLM request preparation errors
   - Model listing failures
   - Database operation failures
   - ASR processing errors
   - Conversation/message/user CRUD errors
   - MCP server listing errors
   - Message save failures during streaming (line 293)
   - General stream errors (line 296)

2. **`llm_adapter.py`** - LLM communication layer errors:
   - LLM provider call failures (model, messages info logged)
   - Stream processing errors
   - Model listing errors
   - Text generation errors
   - Model pull errors

3. **`llm_providers/ollama_provider.py`** - Ollama API errors:
   - Chat request failures (includes model name)
   - Model listing failures
   - Generate request failures
   - Model pull failures

**Pattern**: All errors are logged with contextual information (username, model name, conversation_id, etc.) and full stack traces, then re-raised to allow proper HTTP error responses. This ensures failures (especially Ollama server connection issues) are visible in logs while maintaining clean error responses to clients.

**Exception Handling Best Practice**:
```python
# Re-raise HTTPException without logging (avoid logging 404s)
except HTTPException:
    raise
except Exception as e:
    logger.error(f"Descriptive message with context: {e}", exc_info=True)
    raise HTTPException(status_code=500, detail=str(e))
```

### Context Management

Context is managed in `ollama_adapter.py` using module-level state:

```python
# Context keyed by (conversation_id, chunk_id)
_contexts = {
    (conv_id, chunk_id): {
        "messages": [...],  # List of message dicts
        "loaded": True      # Whether chunk messages loaded from DB
    }
}
```

**Context loading**:
- Lazy-loaded from database on first chat request
- Cached in memory for subsequent requests
- No explicit TTL - context persists until server restart

### Database Sessions

Connection pool configuration:

- Pool size: 10 base + 20 overflow
- Pool recycle: 1 hour
- Pre-ping enabled for connection health checks

### Streaming Response Format

Chat endpoint returns JSON Lines (newline-delimited JSON):

```python
async def stream():
    # Stream sentence-by-sentence to frontend for real-time display
    grouped_messages = []
    current_role = None
    current_content = ""

    async for sentence_chunk in response_generator:
        # Yield each sentence immediately to frontend with metadata
        yield json.dumps({
            "message": sentence_chunk,
            "conversation_id": conversation_id,
            "chunk_id": chunk_id
        }) + "\n"

        # Group by role for database
        if sentence_chunk["role"] != current_role:
            if current_role and current_content:
                grouped_messages.append({"role": current_role, "content": current_content, ...})
            current_role = sentence_chunk["role"]
            current_content = sentence_chunk["content"]
        else:
            current_content += sentence_chunk["content"]

    # Save complete paragraphs to database (grouped by role)
    db_services.create_message(username, user_message, ...)  # User message (not streamed to frontend)
    for msg in grouped_messages:  # Complete assistant/tool paragraphs
        db_services.create_message(username, msg, ...)

    # IMPORTANT: Send "done" signal to frontend
    yield json.dumps({"done": True}) + "\n"

return StreamingResponse(
    stream(),
    media_type="application/x-ndjson",
    headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
)
```

**All chunks include**:
- `conversation_id`: Conversation ID (may be auto-created)
- `chunk_id`: Chunk ID
- `message`: Sentence fragments for real-time streaming (assistant/tool responses only)

**Final chunk**:
- `done`: `True` - Signals streaming completion to frontend

**Database storage**:
- User message saved to database (but not streamed to frontend)
- Agent responses grouped by role into complete paragraphs
- One database row per role change (not per sentence)

**Note**: Uses `media_type="application/x-ndjson"` (newline-delimited JSON) with `Cache-Control: no-cache` and `X-Accel-Buffering: no` headers to prevent buffering and enable real-time streaming

### Message Persistence Pattern

**Important**: Database writes are **deferred until after streaming completes** and **messages are grouped by role**:

1. `llm_hub.py` handles ALL business logic:
   - Loads context from DB via `context/manager.py`
   - Builds system prompts via `prompts/builder.py`
   - Creates user message
   - Calls `llm_adapter.chat()` with complete message list
2. `llm_adapter.chat()` yields sentence-by-sentence for real-time display (pure LLM interface)
3. `llm_hub.py` streams sentences to frontend AND groups them by role:
   - Sentence chunks from same role are accumulated into complete paragraphs
   - When role changes (e.g., assistant → tool), starts a new message
4. After stream completes, `db_services.create_message()` saves complete messages:
   - User message saved as one complete message
   - Assistant responses saved as complete paragraphs (not sentence-by-sentence)
   - Tool responses saved as separate complete messages
5. Each role change creates a new database row

This pattern:
- **Strict separation**: `llm_adapter` = pure LLM, `llm_hub` = business logic + persistence
- **Real-time streaming**: Frontend receives sentence-by-sentence for typing effect
- **Clean database**: Each message is a complete paragraph, not fragmented sentences
- Reduces database load (one write per role, not per sentence)
- Follows standard practice (adapters don't write to DB)
- Enables easy swapping of LLM providers

### Repository Usage Pattern

When adding new database operations:

1. Add methods to appropriate repository class (`db/repositories/*.py`)
2. Keep repositories focused on data access (CRUD operations)
3. Business logic stays in `db/services.py`
4. Use repository methods within `with get_session()` context

Example:
```python
def some_operation(username: str) -> ResultType:
    with get_session() as session:
        user_repo = UserRepository(session)
        conv_repo = ConversationRepository(session)
        # Multiple repos can share same session for transactions
        user = user_repo.get_by_username(username)
        conversation = conv_repo.create_conversation(username)
        return result
```

## Environment Configuration

Required environment variables (see `.env_template`):

```bash
# Database (llm-hub service)
POSTGRES_USER=kurisu
POSTGRES_PASSWORD=kurisu
POSTGRES_HOST=postgres-container
POSTGRES_PORT=5432
POSTGRES_DB=kurisu

# LLM Integration
LLM_API_URL=http://ollama-container:11434

# Authentication
JWT_SECRET_KEY=<random-secret>
ACCESS_TOKEN_EXPIRE_DAYS=30

# TTS (tts-hub service)
TTS_API_URL=http://gpt-sovits-container:9880/tts
```

## Database Schema

Main tables with relationships:

```
User (PK: username)
├── username: String
├── password: Text (bcrypt hash)
├── system_prompt: Text
├── preferred_name: Text
├── user_avatar_uuid: String
└── agent_avatar_uuid: String

Conversation (PK: id)
├── id: Integer
├── username: FK → users.username
├── title: Text
├── created_at: DateTime
└── updated_at: DateTime

Chunk (PK: id)
├── id: Integer
├── conversation_id: FK → conversations.id
├── created_at: DateTime
└── updated_at: DateTime

Message (PK: id)
├── id: Integer
├── role: Text (user/assistant/tool)
├── username: String (denormalized)
├── message: Text
├── chunk_id: FK → chunks.id
├── created_at: DateTime
└── updated_at: DateTime
```

**Chunk Model**: Chunks segment conversations into context windows. Each chunk contains a sequence of messages. When context exceeds limits or user explicitly creates a new chunk, messages go into a new chunk.

## API Endpoint Structure

### Health & Status

#### `GET /health` (Unprotected)
Returns service health status.

**Response**:
```json
{
  "status": "ok",
  "service": "llm-hub"
}
```

### Authentication

#### `POST /login` (Unprotected)
Authenticate user and receive JWT token.

**Request**: OAuth2PasswordRequestForm
- `username`: string
- `password`: string

**Response**:
```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
  "token_type": "bearer"
}
```

**Error (400)**:
```json
{
  "detail": "Incorrect username or password"
}
```

#### `POST /register` (Unprotected)
Create new user account.

**Request**: OAuth2PasswordRequestForm
- `username`: string
- `password`: string

**Response**:
```json
{
  "status": "ok"
}
```

**Errors**:
- `400`: User already exists
- `500`: Internal error

### Speech Recognition

#### `POST /asr` (Protected)
Convert audio to text using Whisper.

**Request**: Binary audio data (application/octet-stream)

**Response**:
```json
{
  "text": "transcribed text content"
}
```

### Chat & LLM

#### `POST /chat` (Protected)
Stream chat responses with LLM. Returns JSON Lines (newline-delimited JSON).

**Request**: multipart/form-data
- `text`: string (required) - User message
- `model_name`: string (required) - LLM model to use
- `conversation_id`: int | null - Conversation ID (null = create new)
- `images`: file[] - Optional image attachments

**Response**: Streaming JSON Lines
```jsonl
{"message": {"role": "assistant", "content": "...", "created_at": "..."}, "conversation_id": 1, "chunk_id": 1}
{"message": {"role": "assistant", "content": "...", "created_at": "..."}, "conversation_id": 1, "chunk_id": 1}
{"message": {"role": "tool", "content": "...", "tool_call_id": "...", "created_at": "..."}, "conversation_id": 1, "chunk_id": 1}
{"done": true}
```
**Note**:
- User message is saved to database but NOT streamed to frontend
- All agent response chunks include `conversation_id` and `chunk_id`
- Final chunk contains `{"done": true}` to signal streaming completion

**All chunks include**:
- `conversation_id`: Auto-created if null was provided
- `chunk_id`: Current chunk ID
- `message`: Agent response message (assistant or tool role only)

**Message roles**: "assistant", "tool" (user messages not streamed)

#### `GET /models` (Protected)
List available LLM models.

**Response**:
```json
{
  "models": [
    "llama3.2:latest",
    "mistral:latest",
    ...
  ]
}
```

### Conversations

#### `GET /conversations` (Protected)
List user's conversations.

**Query Parameters**:
- `limit`: int (default: 50) - Max conversations to return

**Response**:
```json
[
  {
    "id": 1,
    "title": "Conversation Title",
    "created_at": "2025-01-15T10:30:00",
    "updated_at": "2025-01-15T11:45:00",
    "message_count": 42
  },
  ...
]
```

#### `GET /conversations/{conversation_id}` (Protected)
Get conversation details with messages.

**Query Parameters**:
- `limit`: int (default: 50) - Messages per page
- `offset`: int (default: 0) - Pagination offset from the newest messages

**Pagination Behavior**:
- Messages are fetched in **reverse chronological order** (newest first) with offset/limit
- Results are then **reversed** before returning, so they appear in chronological order (oldest first within the page)
- Example with 100 total messages:
  - `offset=0, limit=50`: Returns messages 51-100 (newest 50 messages)
  - `offset=50, limit=50`: Returns messages 1-50 (older 50 messages)
- This enables infinite scroll: load newest messages first, then load older messages as user scrolls up

**Response**:
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
      "chunk_id": 1,
      "created_at": "2025-01-15T10:30:00"
    },
    ...
  ],
  "total_messages": 100,
  "offset": 0,
  "limit": 50,
  "has_more": true
}
```

**Error (404)**: Conversation not found

#### `POST /conversations/{conversation_id}` (Protected)
Update conversation title.

**Request**:
```json
{
  "title": "New Title"
}
```

**Response**:
```json
{
  "message": "Conversation title updated successfully"
}
```

**Errors**:
- `400`: Title is required
- `404`: Conversation not found

#### `DELETE /conversations/{conversation_id}` (Protected)
Delete conversation and all its messages.

**Response**:
```json
{
  "message": "Conversation deleted successfully"
}
```

**Error (404)**: Conversation not found

#### `GET /conversations/{conversation_id}/chunks` (Protected)
List all chunks in a conversation.

**Response**:
```json
{
  "chunks": [
    {
      "id": 1,
      "conversation_id": 1,
      "message_count": 25,
      "created_at": "2025-01-15T10:30:00",
      "updated_at": "2025-01-15T11:00:00"
    },
    ...
  ]
}
```

**Error (404)**: Conversation not found

### Messages

#### `GET /messages/{message_id}` (Protected)
Get specific message by ID.

**Response**:
```json
{
  "id": 1,
  "role": "user",
  "content": "Message content",
  "conversation_id": 1,
  "created_at": "2025-01-15T10:30:00"
}
```

**Error (404)**: Message not found

### User Profile

#### `GET /users/me` (Protected)
Get current user profile.

**Response**:
```json
{
  "username": "admin",
  "system_prompt": "You are a helpful assistant...",
  "preferred_name": "John",
  "user_avatar_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000"
}
```

**Note**: Avatar UUIDs are null if not set.

#### `PUT /users/me` (Protected)
Update user profile.

**Request**: multipart/form-data
- `system_prompt`: string (optional) - Custom system prompt
- `preferred_name`: string (optional) - User's preferred name
- `user_avatar`: file (optional) - User avatar image (empty file = clear)
- `agent_avatar`: file (optional) - Agent avatar image (empty file = clear)

**Response**:
```json
{
  "status": "ok",
  "user_avatar_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000"
}
```

**Note**: Returns updated avatar UUIDs (null if cleared).

### Images

#### `POST /images` (Protected)
Upload image and get UUID.

**Request**: multipart/form-data
- `file`: file (required) - Image file

**Response**:
```json
{
  "image_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "url": "/images/550e8400-e29b-41d4-a716-446655440000"
}
```

#### `GET /images/{image_uuid}` (Public)
Retrieve uploaded image.

**Response**: Image file (image/jpeg or image/png)

**Headers**:
- `Cache-Control`: "public, max-age=31536000, immutable"

**Error (404)**: Image not found

### MCP Servers

#### `GET /mcp-servers` (Protected)
List configured MCP servers and their status.

**Response**:
```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "python",
      "args": ["-m", "mcp_tools.filesystem.main"],
      "status": "available"
    },
    ...
  ]
}
```

**Status values**: "configured", "available", "unavailable"

### Important Notes

- **No `POST /conversations`**: Conversations auto-created when sending first message with `conversation_id=None` to `/chat`
- **No `GET /needs-admin`**: Admin account always exists (created by migrations)
- **Protected endpoints**: Require `Authorization: Bearer <token>` header
- **Streaming responses**: `/chat` uses JSON Lines format (one JSON object per line)

## Important Implementation Notes

### Conversation Creation Flow

Conversations are **NOT** created via explicit API call:

1. User sends message with `conversation_id=None` to `POST /chat`
2. Backend auto-creates conversation and chunk
3. First streaming response includes `conversation_id` and `chunk_id`
4. Frontend updates state with returned IDs

**Rationale**: Eliminates empty conversations and simplifies client code.

### Chunk Management

Chunk management is **fully automatic and internal** - clients never see or specify `chunk_id`:

- Chunks are auto-created on first message to new conversation
- Backend always continues on the latest chunk for each conversation
- `chunk_id` is returned in streaming responses for client state tracking only
- Clients cannot specify which chunk to use (this is an internal implementation detail)

### Message Persistence

Messages are saved **after streaming completes** in `llm_hub.py`:

```python
# In stream() function
messages_to_save = []

async for chunk in response_generator:
    messages_to_save.append(chunk)
    yield json.dumps(wrapped_chunk) + "\n"

# After streaming
for msg in messages_to_save:
    db_services.create_message(username, msg, conversation_id, chunk_id)
```

Each message is a **new database row** - no append/upsert logic.

### Image Handling

Images uploaded via `POST /chat` or `POST /users/me`:

1. Stored in `data/image_storage/data/` with UUID filenames
2. Converted to base64 for LLM processing
3. Embedded as markdown `![Image](/images/{uuid})` in message content
4. Served publicly via `GET /images/{uuid}` with 1-year cache headers

### Tool Calling Flow

When LLM returns tool calls:

1. `ollama_adapter.chat()` detects `msg.tool_calls` in streaming response
2. Calls `mcp_tools.client.call_tool()` with conversation_id injection
3. Yields tool result as `{"role": "tool", ...}` message
4. Continues streaming with tool context

All tool messages saved to database after streaming completes.

## Running Tests

**Note**: Test infrastructure not currently in repository. When adding tests:

- Use pytest framework
- Place tests in `tests/` directory
- Test repositories independently with in-memory SQLite
- Mock external services (Ollama, MCP servers)

## Docker Volume Persistence

Important volumes to back up:

- `postgres-data`: Database persistence
- `./data`: Image uploads and user avatars
- `./ollama`: Ollama model cache
- `./openwebui`: Open WebUI data
