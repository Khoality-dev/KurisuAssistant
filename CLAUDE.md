# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining Speech-to-Text (Whisper), Text-to-Speech (GPT-SoVITS), and LLM capabilities (via Ollama). The system uses a microservices architecture orchestrated with Docker Compose.

## Architecture

### Service Structure

The application consists of multiple containerized services:

- **nginx** (ports 80/443): Reverse proxy with HTTPS termination (self-signed certs)
- **api** (internal port 15597): Main FastAPI application (`main.py`) handling chat, authentication, conversation management, and TTS
- **postgres** (internal port 5432): PostgreSQL 16 database for persistence (not exposed to host)
- **gpt-sovits** (port 9880): Voice synthesis engine (external TTS backend)

**Note**: The standalone `tts-hub` service has been removed. TTS functionality is now integrated into the main application via the `tts_providers` abstraction layer.

### Database Layer Pattern

The codebase uses a **Repository Pattern** with a generic base class:

```
db/
├── models.py          # SQLAlchemy ORM models
├── session.py         # Session management with connection pooling
└── repositories/
    ├── base.py        # BaseRepository[T] with generic CRUD
    ├── user.py        # UserRepository
    ├── conversation.py # ConversationRepository
    ├── frame.py       # FrameRepository (context frames)
    ├── message.py     # MessageRepository
    └── agent.py       # AgentRepository
```

**Key Pattern**: Repository classes use context managers (`with get_session()`) for automatic transaction handling. Routers and handlers call repository methods directly.

### LLM Integration Architecture

The LLM integration follows a **clean separation of concerns** with modular components:

```
routers/chat.py (business logic - users, conversations, frames, DB)
  ├─> utils/prompts.py (build system prompts from user preferences)
  └─> llm/ (pure LLM interface - no DB knowledge)
        └─> llm/providers/ollama_provider.py (LLM API calls)
```

**Key Modules**:

1. **`llm/`** - LLM provider package
   - Pure LLM interface (NO business logic)
   - NO knowledge of users, conversations, frames, or database
   - Delegates to providers for actual LLM API calls

2. **`llm/providers/`** - LLM provider abstraction
   - `base.py`: Abstract `BaseLLMProvider` interface
   - `ollama_provider.py`: Ollama implementation
   - `__init__.py`: Factory function `create_llm_provider(api_url)`
   - Supports multiple LLM backends (Ollama, OpenAI, etc.)
   - Per-request URL customization via `api_url` parameter (for user-specific Ollama servers)

3. **`utils/prompts.py`** - System prompt building
   - `build_system_messages()`: Combine global + user prompts + timestamp + preferred name
   - Loads global prompt from `SYSTEM_PROMPT.md`

**Important**: All business logic (context, prompts, user preferences, database) is handled in routers BEFORE calling `llm.chat()`. The LLM module is a pure communication layer.

### MCP (Model Context Protocol) Integration

MCP tools provide external capabilities to the LLM via the Model Context Protocol:

- `mcp_tools/config.py`: Scans for tool configs and merges them
- `mcp_tools/client.py`: Async wrappers for `list_tools()` and `call_tool()`
- `mcp_tools/orchestrator.py`: Singleton orchestrator with tool caching and execution
- Automatic `conversation_id` injection for context-aware tools

**Context Retrieval Tools** (built-in tools in `tools/context.py`):
- `SearchMessagesTool` (`search_messages`): Unified search with text/regex query and/or date range filtering
- `GetConversationInfoTool` (`get_conversation_info`): Get conversation metadata (title, dates, message/frame counts)

These are registered as built-in tools in `tools/__init__.py` and receive `conversation_id` automatically via injection in `agents/base.py:execute_tool()`.

Example MCP tool structure (for custom tools):
```
mcp_tools/custom-tool/
├── main.py          # Tool server implementation
├── config.json      # Server configuration
└── requirements.txt # Python dependencies
```

### Unified Tool System

```
tools/
├── __init__.py    # Registers built-in tools in global registry
├── base.py        # BaseTool abstract class
├── registry.py    # ToolRegistry, global tool_registry singleton
├── routing.py     # RouteToAgentTool, RouteToUserTool (built-in routing tools)
└── context.py     # SearchMessagesTool, GetConversationInfoTool (context querying tools)
```

**Built-in Routing Tools**: `RouteToAgentTool` and `RouteToUserTool` are registered as built-in tools in `tools/__init__.py`. They appear on the Tools page alongside MCP tools but are not user-configurable. The Administrator uses these tools internally for agent routing decisions.

**Built-in Context Tools**: `SearchMessagesTool` and `GetConversationInfoTool` are registered as built-in tools. They query conversation history via the database and receive `conversation_id` automatically injected by `execute_tool()` in `agents/base.py`. Agents can use these to search past messages or retrieve conversation metadata.

### Multi-Agent Orchestration Architecture

The system uses **turn-based orchestration** where an Administrator agent manages conversation flow and routes messages between agents.

```
agents/
├── base.py           # BaseAgent, SimpleAgent, AgentConfig, AgentContext
├── router.py         # RouterAgent (legacy delegation via tools)
├── orchestration.py  # OrchestrationSession, OrchestrationLog, AdministratorDecision
└── administrator.py  # AdministratorAgent (LLM-based router)
```

**Key Components**:

1. **AdministratorAgent** (`agents/administrator.py`)
   - System-level LLM-based router (NOT a user agent)
   - Receives ALL messages (from user and agents)
   - Decides which agent should respond next
   - Detects when conversation topic is complete
   - NOT displayed in main chat by default (toggle via `showAdministrator`)
   - Routing decisions (tool calls) are yielded with `role="tool"` and `agent_name` set to the tool name (`route_to_agent`, `route_to_user`), creating separate bubbles from the Administrator's LLM reasoning content

2. **OrchestrationSession** (`agents/orchestration.py`)
   - Tracks turn-based conversation state
   - `turn_count`: Current turn number
   - `max_turns`: Maximum turns before forcing end (default: 10)
   - `current_agent_id/name`: Active agent

3. **SimpleAgent** (`agents/base.py`)
   - Equal-tier responders (all user-created agents)
   - Processes messages with LLM and tools
   - No special routing logic
   - `_prepare_messages()` builds a unified system prompt: agent identity + agent's system_prompt + user's system_prompt + preferred_name + timestamp + other agent descriptions. System messages from conversation history are filtered out (already incorporated). Administrator messages are also filtered.

**Turn-Based Flow**:
```
[User Turn]
User sends message via WebSocket
    ↓
Administrator selects initial agent
    ↓
[Agent Turn 1]
Selected Agent processes message
Agent responds with content
    ↓
Administrator analyzes response → determines target
    ↓
[If target is another agent]
Route to that agent → Agent Turn 2
    ↓
[If target is user]
End orchestration loop, system idle
```

**WebSocket Events for Orchestration**:
- `TurnUpdateEvent`: Turn counter updates (turn_count, max_turns, current_agent)
- `LLMLogEvent`: Full LLM call logs for debugging panel
- `AgentSwitchEvent`: Agent change notifications

**Message Routing Patterns**:
1. **User → Agent**: User sends message, Administrator selects agent
2. **Agent → User**: Agent responds, Administrator detects user-targeted response
3. **Agent → Agent**: Agent's response mentions/requests another agent

**Configuration**:
```python
DEFAULT_MAX_TURNS = 10        # Maximum agent turns per user message
DEFAULT_ADMIN_MODEL = "gemma3:4b"  # Fast model for routing decisions
```

**WebSocket Reconnection & State Recovery**:

The handler stores accumulated messages (not individual chunk events) for efficient state recovery when the same user reconnects during or after streaming:

- `_accumulated_messages`: Complete messages grouped by role/agent (same structure as `messages_to_save`)
- `_current_chunk`: In-progress content while an agent is still generating
- `_task_conversation_id` / `_task_frame_id`: Metadata for replay events
- `_task_done`: Whether the orchestration has completed

On reconnect, `replace_websocket()` replays each accumulated message as a complete `StreamChunkEvent`, then sends the in-progress chunk (if still generating) or `DoneEvent` (if already done). The client-side conversation ID guard filters replayed events so they only display for the active conversation.

Memory efficiency: Stores ~5-15 complete messages per task instead of hundreds of individual chunk events.

### TTS Integration Architecture

The TTS integration follows a **provider pattern** similar to the LLM integration:

```
main.py (business logic)
  └─> tts_adapter.py (pure TTS interface)
        └─> tts_providers/gpt_sovits_provider.py (TTS API calls)
```

**Key Modules**:

1. **`tts_adapter.py`** - Pure TTS interface (NO business logic)
   - Orchestrates TTS synthesis calls
   - NO knowledge of users, conversations, or database
   - Delegates to `tts_providers` for actual TTS API calls

2. **`tts_providers/`** - TTS provider abstraction
   - `base.py`: Abstract `BaseTTSProvider` interface
   - `gpt_sovits_provider.py`: GPT-SoVITS implementation
     - Sends path as query parameter to container (normalized to POSIX format with `.as_posix()`)
   - `index_tts_provider.py`: INDEX-TTS implementation (emotionally expressive zero-shot TTS)
     - Sends file content via multipart/form-data (opens file locally, sends bytes)
   - `__init__.py`: Factory function `create_tts_provider()`
   - Supports multiple TTS backends (GPT-SoVITS, INDEX-TTS, etc.)

**Provider Pattern**: TTS uses the same provider pattern as LLM integration, allowing easy swapping of TTS backends without changing application code. Providers can be:
- Configured globally via `TTS_PROVIDER` env var (default: "gpt-sovits")
- Selected per-request via the `provider` parameter in API calls
- Multiple providers can be used simultaneously (lazy-initialized on first use)

**Available Providers**:
- `gpt-sovits`: GPT-SoVITS backend with automatic text splitting for long prompts
- `index-tts`: INDEX-TTS backend with emotion control (audio-based, vector-based, or text-based)

**Voice Discovery**: Both providers scan the `data/voice_storage/` directory for audio files and expose them via the `/tts/voices` endpoint. Simply add new reference audio files to the `data/voice_storage/` folder to make them available.

**Security**: Frontend MUST only send voice names (e.g., "ayaka_ref") returned from `/tts/voices`, never paths. Backend enforces this by:
- Only accepting voice names without extensions
- Always searching in `data/voice_storage/` directory only
- Using `_find_voice_file()` to locate files with proper extensions
- Preventing path traversal attacks

**Text Splitting** (Both providers): Long prompts are automatically split into smaller chunks (default: 200 characters) to prevent OOM during inference. Each chunk is synthesized separately and merged into a single WAV file.
- Splits by paragraphs first (double newline)
- Then by sentences (using delimiters: 。.!?！？\n)
- Respects max_chunk_length parameter (configurable via API)
- Merges WAV files by concatenating audio data while preserving headers

**Emotion Control** (INDEX-TTS only): Supports multiple emotion control methods:
- Emotion reference audio (`emo_audio` parameter)
- Emotion vector (`emo_vector` parameter: [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm])
- Text-based emotion (`use_emo_text=True` with optional `emo_text` description)
- Emotion strength control (`emo_alpha`: 0.0-1.0)

**Frontend Integration**: The client application (`KurisuAssistant-Client-Windows`) has full support for TTS backend selection:
- Backend selector in Settings page for persistent preferences
- Backend selector in ChatWidget for per-session switching
- All settings stored in localStorage (client-specific)
- Automatic discovery of available backends via `/tts/backends` endpoint
- **Streaming TTS Auto-Play**: When enabled, sentences are batched and synthesized in parallel during streaming, then played sequentially via a FIFO queue. Sentence boundaries (`.!?。！？\n`) trigger immediate synthesis. Buffer is flushed on stream completion or agent switch.

See `TTS_FRONTEND_INTEGRATION.md` for detailed examples of integrating TTS playback in React, TypeScript, and vanilla JavaScript applications.

## Development Commands

### Local Development

```bash
# Setup virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Run migrations manually
python migrate.py

# Create reference directory for TTS voices (if not exists)
mkdir reference

# Start server locally
./run_dev.bat  # Windows
```

**Note**: Place reference audio files for TTS voices in the `data/voice_storage/` directory. Supported formats: `.wav`, `.mp3`, `.flac`, `.ogg`.

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

## Key Files & Entry Points

- **`main.py`**: Main FastAPI application (formerly `llm_hub.py`)
  - All API endpoints (chat, auth, conversations, messages, users, images, TTS)
  - Application lifespan management
  - CORS configuration

- **`llm_adapter.py`**: Pure LLM interface layer
- **`tts_adapter.py`**: Pure TTS interface layer
- **`docker-entrypoint.sh`**: Docker container startup script
- **`run_dev.bat`**: Local development startup script (Windows)
- **`migrate.py`**: Database migration runner

## Key Patterns & Conventions

### Authentication

JWT-based authentication with bcrypt password hashing:

```python
# Token generation (core/security.py)
- Algorithm: HS256
- Expiration: 30 days (configurable via ACCESS_TOKEN_EXPIRE_DAYS)
- Secret: JWT_SECRET_KEY environment variable

# Protected endpoints
- Dependency: Depends(get_authenticated_user)
- Returns: User object (detached from session)
- Use: user.id for DB operations, user.username for API responses
- Raises: HTTPException(401) if invalid
```

### Error Logging

Comprehensive error logging is implemented throughout the application using Python's standard `logging` module:

**Logging Configuration**:
- Configured in `main.py` with `logging.basicConfig(level=logging.INFO)`
- Each module creates its own logger: `logger = logging.getLogger(__name__)`
- Logs include full stack traces via `exc_info=True` for debugging

**Error Logging Locations**:

1. **`main.py`** - All endpoint errors logged before raising HTTPException:
   - LLM request preparation errors
   - Model listing failures
   - Database operation failures
   - ASR processing errors
   - Conversation/message/user CRUD errors
   - MCP server listing errors
   - TTS synthesis errors
   - Message save failures during streaming
   - General stream errors

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

4. **`tts_adapter.py`** - TTS communication layer errors:
   - TTS provider call failures
   - Voice listing errors

5. **`tts_providers/gpt_sovits_provider.py`** - GPT-SoVITS API errors:
   - TTS synthesis request failures (includes voice name)
   - Reference directory scanning errors

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

Context is loaded fresh on each request from the database:

```python
# Context loaded per request via frame_id
messages = msg_repo.get_by_frame(frame_id, limit=1000)
```

**Context loading**:
- Loaded from database on each chat request
- No in-memory caching (stateless design)
- Messages organized by frame (context window)

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
            "frame_id": frame_id
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
    msg_repo.create_message(role, message, frame_id)  # User message (not streamed to frontend)
    for msg in grouped_messages:  # Complete assistant/tool paragraphs
        msg_repo.create_message(role, message, frame_id)

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
- `frame_id`: Frame ID (context frame)
- `message`: Sentence fragments for real-time streaming (assistant/tool responses only)
  - May include `thinking` field in the final message chunk (only for assistant messages with thinking enabled)

**Final chunk**:
- `done`: `True` - Signals streaming completion to frontend

**Database storage**:
- User message saved to database (but not streamed to frontend)
- Agent responses grouped by role into complete paragraphs
- One database row per role change (not per sentence)
- Thinking blocks (if present) accumulated progressively during streaming and saved with the assistant message

**Note**: Uses `media_type="application/x-ndjson"` (newline-delimited JSON) with `Cache-Control: no-cache` and `X-Accel-Buffering: no` headers to prevent buffering and enable real-time streaming

### Message Persistence Pattern

**Important**: Database writes are **deferred until after streaming completes** and **messages are grouped by role**:

1. `main.py` handles ALL business logic:
   - Loads context from DB via `context/manager.py`
   - Builds system prompts via `prompts/builder.py`
   - Creates user message
   - Calls `llm_adapter.chat()` with complete message list
2. `llm_adapter.chat()` yields sentence-by-sentence for real-time display (pure LLM interface)
3. `main.py` streams sentences to frontend AND groups them by role:
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

### Thinking Support

**Overview**: The system supports capturing and displaying LLM thinking blocks (extended chain-of-thought reasoning) for models that support this feature.

**Implementation Flow**:

1. **LLM Adapter** (`llm_adapter.py:66-136`):
   - Captures thinking content from Ollama response stream via `getattr(msg, 'thinking', None)`
   - Yields thinking chunks immediately as they arrive from the LLM
   - Each thinking chunk has empty content field and thinking field: `{"content": "", "thinking": "..."}`
   - Thinking is streamed progressively along with content chunks

2. **Streaming** (`main.py:285-348`):
   - Frontend receives both content and thinking chunks in real-time
   - Thinking chunks have empty content field: `{"content": "", "thinking": "..."}`
   - Content chunks have thinking field empty or omitted
   - Both are accumulated progressively on the frontend

3. **Database Persistence**:
   - Thinking saved to `messages.thinking` column (nullable TEXT)
   - Only included in assistant messages (user/tool messages don't have thinking)
   - Stored with the complete assistant message after streaming completes

4. **API Responses**:
   - `GET /conversations/{id}`: Returns `thinking` field if present for each message
   - `GET /messages/{id}`: Returns `thinking` field if present
   - Frontend can toggle visibility (hidden by default)

**Database Schema**:
- Column: `messages.thinking` (TEXT, nullable)
- Migration: `7dd75b21ce44_add_thinking_field_to_messages.py`

**Frontend Integration**:
- Messages with thinking should display a toggle button
- Thinking content shown/hidden via button click (default: hidden)
- Thinking appears as separate collapsible section below message content

### Repository Usage Pattern

When adding new database operations:

1. Add methods to appropriate repository class (`db/repositories/*.py`)
2. Keep repositories focused on data access (CRUD operations)
3. Business logic stays in routers/handlers
4. Use repository methods within `with get_session()` context

Example:
```python
def some_operation(user: User) -> ResultType:
    with get_session() as session:
        user_repo = UserRepository(session)
        conv_repo = ConversationRepository(session)
        # Multiple repos can share same session for transactions
        # Use user.id (not username) for all DB operations
        conversation = conv_repo.create_conversation(user.id)
        return result
```

**Important**: All repositories use `user_id: int` instead of `username: str` for ownership checks. The `get_authenticated_user` dependency returns a User object - use `user.id` for DB operations.

## Environment Configuration

Required environment variables (see `.env_template`):

```bash
# Database
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

# TTS Integration
TTS_PROVIDER=gpt-sovits  # or "index-tts"
TTS_API_URL=http://gpt-sovits-container:9880/tts  # For GPT-SoVITS
INDEX_TTS_API_URL=http://localhost:19770  # For INDEX-TTS
```

## Database Schema

Main tables with relationships:

```
User (PK: id)
├── id: Integer (auto-increment)
├── username: String (unique)
├── password: Text (bcrypt hash)
├── system_prompt: Text
├── preferred_name: Text
├── user_avatar_uuid: String
├── agent_avatar_uuid: String
└── ollama_url: String (nullable, custom Ollama server URL)

Conversation (PK: id)
├── id: Integer
├── user_id: FK → users.id
├── title: Text
├── created_at: DateTime
└── updated_at: DateTime

Frame (PK: id) - context frames
├── id: Integer
├── conversation_id: FK → conversations.id
├── created_at: DateTime
└── updated_at: DateTime

Message (PK: id)
├── id: Integer
├── role: Text (user/assistant/tool)
├── message: Text
├── thinking: Text (nullable, for assistant messages)
├── raw_input: Text (nullable, JSON of messages array sent to LLM)
├── raw_output: Text (nullable, full concatenated LLM response)
├── name: String (nullable, display name - agent name or tool name)
├── frame_id: FK → frames.id
├── agent_id: FK → agents.id (nullable, SET NULL on delete)
└── created_at: DateTime

Agent (PK: id)
├── id: Integer
├── user_id: FK → users.id
├── name: String
├── system_prompt: Text
├── voice_reference: String
├── avatar_uuid: String
├── model_name: String
├── tools: JSON
├── think: Boolean (default: False, enable extended reasoning)
└── created_at: DateTime
```

**Frame Model**: Frames segment conversations into context windows. Each frame contains a sequence of messages. When context exceeds limits or user explicitly creates a new frame, messages go into a new frame.

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
{"message": {"role": "assistant", "content": "...", "created_at": "..."}, "conversation_id": 1, "frame_id": 1}
{"message": {"role": "assistant", "content": "...", "created_at": "..."}, "conversation_id": 1, "frame_id": 1}
{"message": {"role": "tool", "content": "...", "tool_call_id": "...", "created_at": "..."}, "conversation_id": 1, "frame_id": 1}
{"done": true}
```
**Note**:
- User message is saved to database but NOT streamed to frontend
- All agent response chunks include `conversation_id` and `frame_id`
- Final chunk contains `{"done": true}` to signal streaming completion

**All chunks include**:
- `conversation_id`: Auto-created if null was provided
- `frame_id`: Current frame ID (context frame)
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
      "frame_id": 1,
      "created_at": "2025-01-15T10:30:00",
      "has_raw_data": false
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

#### `GET /conversations/{conversation_id}/frames` (Protected)
List all frames in a conversation.

**Response**:
```json
{
  "frames": [
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
  "created_at": "2025-01-15T10:30:00",
  "has_raw_data": false
}
```

**Error (404)**: Message not found

#### `GET /messages/{message_id}/raw` (Protected)
Get raw LLM input/output for a specific message. Used by frontend to show raw data in a debug panel.

**Response**:
```json
{
  "id": 1,
  "raw_input": [
    {"role": "system", "content": "You are..."},
    {"role": "user", "content": "Hello"}
  ],
  "raw_output": "Full concatenated LLM response text"
}
```

**Note**: `raw_input` is the messages array sent to the LLM API. `raw_output` is the complete concatenated response text (for streaming, all chunks joined). Both fields are null for user messages and messages created before this feature was added.

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
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000",
  "ollama_url": "http://custom-ollama:11434"
}
```

**Note**: Avatar UUIDs and ollama_url are null if not set.

#### `PATCH /users/me` (Protected)
Update user profile text fields (system prompt, preferred name, ollama_url).

**Request** (JSON):
```json
{
  "system_prompt": "Custom instructions...",
  "preferred_name": "John",
  "ollama_url": "http://custom-ollama:11434"
}
```

**Note**: Set `ollama_url` to empty string to clear it (use default server).

**Response**:
```json
{
  "status": "ok",
  "message": "Profile updated successfully"
}
```

#### `PATCH /users/me/avatars` (Protected)
Update user and/or agent avatar images.

**Request** (multipart/form-data):
- `user_avatar`: file (optional) - User avatar image
- `agent_avatar`: file (optional) - Agent avatar image

**Response**:
```json
{
  "status": "ok",
  "user_avatar_uuid": "550e8400-e29b-41d4-a716-446655440000",
  "agent_avatar_uuid": "660e8400-e29b-41d4-a716-446655440000"
}
```

**Note**: Separate endpoints for text fields (JSON) and file uploads (multipart) following REST best practices.

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

### Tools

#### `GET /tools` (Protected)
List all available tools (MCP + built-in).

**Response**:
```json
{
  "mcp_tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read the contents of a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "File path to read"
            }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "builtin_tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_time",
        "description": "Get the current date and time",
        "parameters": {}
      }
    }
  ]
}
```

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

### Text-to-Speech

#### `POST /tts` (Protected)
Synthesize speech from text.

**Request**:
```json
{
  "text": "Hello world",
  "voice": "ayaka_ref",  // Optional - voice name from /tts/voices
  "language": "ja",  // Optional
  "provider": "index-tts"  // Optional - TTS provider to use (defaults to TTS_PROVIDER env var or "gpt-sovits")
}
```

**Provider-Specific Parameters**:

For GPT-SoVITS:
- `max_chunk_length`: Maximum characters per chunk (default: 200)
- `text_split_method`: Text splitting method (default: "cut5")
- `batch_size`: Batch size (default: 20)

For INDEX-TTS:
- `emo_audio`: Voice name for emotion reference audio file (e.g., "happy_ref")
- `emo_vector`: Emotion vector [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
- `emo_text`: Text description for emotion control
- `use_emo_text`: Use emotion from text (default: False)
- `emo_alpha`: Emotion strength 0.0-1.0 (default: 1.0)
- `use_random`: Enable random sampling (default: False)
- `max_chunk_length`: Maximum characters per chunk (default: 200)

**Response**: Audio file (audio/wav)

**Note**: The `voice` parameter should be a voice name returned from `GET /tts/voices` (without path or extension)

**Headers**:
- `Content-Disposition`: "attachment; filename=speech.wav"

**Error (500)**: TTS synthesis failed

#### `GET /tts/voices` (Protected)
List available TTS voices by scanning the `data/voice_storage/` directory.

**Query Parameters**:
- `provider`: TTS provider to use (optional, defaults to TTS_PROVIDER env var or "gpt-sovits")

**Response**:
```json
{
  "voices": ["ayaka_ref", "kurisu_ref", "another_voice"]
}
```

**Note**: Returns audio filenames without extension from the `data/voice_storage/` folder

#### `GET /tts/backends` (Protected)
List available TTS backends.

**Response**:
```json
{
  "backends": ["gpt-sovits", "index-tts"]
}
```

**Note**: Returns list of TTS backend names available in the system. Backends are registered in `tts_providers/__init__.py`.

### Important Notes

- **No `POST /conversations`**: Conversations auto-created when sending first message with `conversation_id=None` to `/chat`
- **No `GET /needs-admin`**: Admin account always exists (created by migrations)
- **Protected endpoints**: Require `Authorization: Bearer <token>` header
- **Streaming responses**: `/chat` uses JSON Lines format (one JSON object per line)

## Important Implementation Notes

### Conversation Creation Flow

Conversations are **NOT** created via explicit API call:

1. User sends message with `conversation_id=None` to `POST /chat`
2. Backend auto-creates conversation and frame
3. First streaming response includes `conversation_id` and `frame_id`
4. Frontend updates state with returned IDs

**Rationale**: Eliminates empty conversations and simplifies client code.

### Frame Management

Frame management is **fully automatic and internal** - clients never see or specify `frame_id`:

- Frames are auto-created on first message to new conversation
- Backend always continues on the latest frame for each conversation
- `frame_id` is returned in streaming responses for client state tracking only
- Clients cannot specify which frame to use (this is an internal implementation detail)

### Message Persistence

Messages are saved **after streaming completes** in routers:

```python
# In stream() function
messages_to_save = []

async for chunk in response_generator:
    messages_to_save.append(chunk)
    yield json.dumps(wrapped_chunk) + "\n"

# After streaming
for msg in messages_to_save:
    msg_repo.create_message(role, message, frame_id)
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

### Agent Tool Access Control

Agents only receive tools they are assigned in their configuration:

- `Agent.tools` (JSON array in DB) stores the list of tool names the agent can use
- `SimpleAgent.process()` calls `tool_registry.get_schemas(config.tools)` — only assigned tools are sent to the LLM
- If `tools` is empty or `None`, the agent gets **no tools** (not all tools)
- `execute_tool()` enforces access: if agent tries to call an unassigned tool, the call is rejected with a warning log
- The Administrator agent is separate — it only has routing tools (`route_to_agent`, `route_to_user`), not the global registry

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
