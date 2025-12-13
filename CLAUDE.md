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
├── operations.py      # High-level business logic (delegates to repositories)
└── repositories/
    ├── base.py        # BaseRepository[T] with generic CRUD
    ├── user.py        # UserRepository
    ├── conversation.py # ConversationRepository
    └── message.py     # MessageRepository
```

**Key Pattern**: `db/operations.py` functions use context managers (`with get_session()`) for automatic transaction handling and delegate to repository classes for database operations.

### Agent & LLM Integration

The `helpers/agent.py` module manages LLM interactions:

- **Session-based context**: Agent instances cached per conversation_id with 10-minute TTL
- **Streaming responses**: Sentences chunked by delimiters (`.`, `\n`, `?`, `:`, `!`, `;`)
- **Tool calling**: MCP (Model Context Protocol) integration with 30-second tool cache
- **Real-time persistence**: Messages saved to database during streaming

### MCP (Model Context Protocol) Integration

MCP tools are configured in `mcp_tools/*/config.json` files:

- `mcp_tools/config.py`: Scans for tool configs and merges them
- `mcp_tools/client.py`: Async wrappers for `list_tools()` and `call_tool()`
- Automatic `conversation_id` injection for context tools (retrieve messages, summaries)

Example MCP tool structure:
```
mcp_tools/mcp-context/
├── main.py          # Tool server implementation
├── db.py            # Database queries for context
├── AGENT.md         # System prompt documentation
└── config.json      # Server configuration
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

### Session Management

Two types of sessions:

1. **Agent Sessions** (in-memory): `sessions = {conversation_id: Agent}`
   - 10-minute timeout for context messages
   - Recreated if expired or missing

2. **Database Sessions** (connection pool):
   - Pool size: 10 base + 20 overflow
   - Pool recycle: 1 hour
   - Pre-ping enabled for connection health checks

### Streaming Response Format

Chat endpoint returns JSON Lines (newline-delimited JSON):

```python
async def stream():
    async for chunk in response_generator:
        wrapped_chunk = {"message": chunk}
        yield json.dumps(wrapped_chunk) + "\n"

return StreamingResponse(stream(), media_type="application/json")
```

### Repository Usage Pattern

When adding new database operations:

1. Add methods to appropriate repository class (`db/repositories/*.py`)
2. Keep repositories focused on data access (CRUD operations)
3. Business logic stays in `db/operations.py` or service layer
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

Message (PK: id)
├── id: Integer
├── role: Text (user/assistant/tool)
├── username: String (denormalized)
├── message: Text
├── conversation_id: FK → conversations.id
├── created_at: DateTime
└── updated_at: DateTime
```

## API Endpoint Structure

Key endpoint patterns:

- **Health**: `GET /health`, `GET /needs-admin` (unprotected)
- **Auth**: `POST /login`, `POST /register` (unprotected)
- **Chat**: `POST /chat`, `GET /models` (protected)
- **Conversations**: `GET /conversations`, `POST /conversations`, `GET /conversations/{id}`, `DELETE /conversations/{id}` (protected)
- **User Profile**: `GET /users/me`, `PUT /users/me` (protected)
- **Images**: `POST /images` (protected), `GET /images/{uuid}` (public)
- **MCP**: `GET /mcp-servers` (protected)

## Important Implementation Notes

### Message Upserting Logic

The `upsert_streaming_message()` function in `db/operations.py` implements smart message accumulation:

- If last message has same role → append content to existing message
- If role differs → create new message
- Always update conversation's `updated_at` timestamp

### Image Handling

Images uploaded via `POST /chat` or `POST /users/me`:

1. Stored in `data/image_storage/data/` with UUID filenames
2. Converted to base64 for LLM processing
3. Embedded as markdown `![Image](/images/{uuid})` in message content
4. Served publicly via `GET /images/{uuid}` with 1-year cache headers

### Tool Calling Flow

When LLM returns tool calls:

1. Agent detects `msg.tool_calls` in streaming response
2. Calls `mcp_tools.client.call_tool()` with conversation_id injection
3. Appends tool result as `{"role": "tool", ...}` message
4. Continues streaming with tool context

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
