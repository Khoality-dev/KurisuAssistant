# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (Whisper), TTS (GPT-SoVITS/INDEX-TTS), and LLM (Ollama). Microservices architecture with Docker Compose.

## Architecture

### Services

- **nginx** (80/443): HTTPS reverse proxy (self-signed certs)
- **api** (internal 15597): Main FastAPI app (`main.py`) — chat, auth, conversations, TTS
- **postgres** (internal 5432): PostgreSQL 16 (not host-exposed)
- **gpt-sovits** (9880): Voice synthesis backend

### Directory Structure

```
db/
├── models.py                # SQLAlchemy ORM models
├── session.py               # Session management (pool: 10+20 overflow, 1hr recycle, pre-ping)
└── repositories/            # Repository pattern with BaseRepository[T] generic CRUD
    ├── base.py, user.py, conversation.py, frame.py, message.py, agent.py

llm/                         # Pure LLM interface (NO business logic/DB knowledge)
├── providers/
│   ├── base.py              # Abstract BaseLLMProvider
│   ├── ollama_provider.py   # Ollama implementation
│   └── __init__.py          # Factory: create_llm_provider(api_url)

tts_adapter.py               # Pure TTS interface (NO business logic)
tts_providers/
├── base.py                  # Abstract BaseTTSProvider
├── gpt_sovits_provider.py   # GPT-SoVITS (path as query param, POSIX format)
├── index_tts_provider.py    # INDEX-TTS (file via multipart/form-data)
└── __init__.py              # Factory: create_tts_provider()

tools/
├── base.py                  # BaseTool abstract class
├── registry.py              # ToolRegistry, global tool_registry singleton
├── routing.py               # RouteToAgentTool, RouteToUserTool (Administrator routing)
└── context.py               # SearchMessagesTool, GetConversationInfoTool

agents/
├── base.py                  # BaseAgent, SimpleAgent, AgentConfig, AgentContext
├── router.py                # RouterAgent (legacy)
├── orchestration.py         # OrchestrationSession, OrchestrationLog
└── administrator.py         # AdministratorAgent (LLM-based router)

mcp_tools/
├── config.py                # Tool config scanning/merging
├── client.py                # Async list_tools()/call_tool() wrappers
└── orchestrator.py          # Singleton orchestrator with caching

utils/prompts.py             # build_system_messages() from SYSTEM_PROMPT.md + user prefs
```

### Key Design Principles

- **Separation of concerns**: Business logic (DB, users, prompts) in routers → pure adapters (`llm/`, `tts_adapter.py`) → provider implementations. Adapters never touch DB.
- **Repository pattern**: Repos use `with get_session()` for transactions. Use `user.id` (not username) for all DB operations.
- **Provider pattern**: Both LLM and TTS use abstract base → concrete provider → factory. Supports runtime provider selection.

### Multi-Agent Orchestration

Turn-based orchestration where **AdministratorAgent** (system-level, not a user agent) routes messages between **SimpleAgents** (user-created, equal-tier).

**Flow**: User message → Administrator selects agent → Agent responds → Administrator routes to next agent or back to user. Max 10 turns per user message. Admin model: `gemma3:4b`.

**WebSocket Events**: `TurnUpdateEvent`, `LLMLogEvent`, `AgentSwitchEvent`

**Agent message preparation** (`SimpleAgent._prepare_messages()`): Builds unified system prompt (agent identity + agent prompt + user prompt + preferred_name + timestamp + other agent descriptions). Filters out system/administrator messages from history.

**Tool access control**: `Agent.tools` JSON array limits which tools each agent can use. Empty = no tools. `execute_tool()` enforces this. Administrator only gets routing tools.

**WebSocket reconnection**: Handler stores `_accumulated_messages` (complete messages, not chunks) for replay. `replace_websocket()` replays accumulated + in-progress chunk or `DoneEvent`. Client filters by conversation ID.

### TTS Details

- **Voice discovery**: Scan `data/voice_storage/` for audio files. Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.
- **Text splitting**: Both providers split long text (default 200 chars) by paragraphs → sentences, merge WAV chunks.
- **Providers**: Configured via `TTS_PROVIDER` env var (default: "gpt-sovits"), overridable per-request.
- **INDEX-TTS emotion**: `emo_audio`, `emo_vector` [8 emotions], `emo_text`, `emo_alpha` (0-1).

### MCP Tools

Built-in context tools (`tools/context.py`) receive `conversation_id` auto-injected by `agents/base.py:execute_tool()`:
- `search_messages`: Text/regex query with date range filtering
- `get_conversation_info`: Conversation metadata

Custom MCP tools go in `mcp_tools/<tool-name>/` with `main.py`, `config.json`, `requirements.txt`.

## Development

```bash
# Local
python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
python migrate.py          # Run migrations
./run_dev.bat              # Start server (Windows)

# Docker
docker-compose up -d       # Start all
docker-compose logs -f api # View logs

# Migrations (Alembic, auto-run on container startup via docker-entrypoint.sh)
cd db && alembic revision --autogenerate -m "description"
```

First migration seeds default `admin:admin` account. Voice files go in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Key Patterns

### Authentication
JWT (HS256, 30-day expiry, `JWT_SECRET_KEY`). Protected endpoints use `Depends(get_authenticated_user)` → returns detached User object.

### Error Handling Pattern
```python
except HTTPException:
    raise  # Don't log expected errors
except Exception as e:
    logger.error(f"Context info: {e}", exc_info=True)
    raise HTTPException(status_code=500, detail=str(e))
```

### Streaming & Persistence
- Chat streams JSON Lines (`application/x-ndjson`) sentence-by-sentence with `conversation_id`, `frame_id`, `message`
- Messages grouped by role during streaming, saved to DB **after stream completes** (one row per role change)
- User message saved to DB but NOT streamed. Final chunk: `{"done": true}`
- Thinking blocks: streamed as `{"content": "", "thinking": "..."}`, saved to `messages.thinking` column

### Conversation & Frame Management
- Conversations auto-created on first message with `conversation_id=None` (no explicit create endpoint)
- Frames auto-managed internally — clients never specify `frame_id`
- Message pagination: reverse chronological fetch, reversed before return (enables infinite scroll)

### Image Handling
Stored in `data/image_storage/data/` with UUID names. Converted to base64 for LLM. Embedded as `![Image](/images/{uuid})`. Served with 1-year cache.

## Database Schema

```
User: id, username, password(bcrypt), system_prompt, preferred_name, user_avatar_uuid, agent_avatar_uuid, ollama_url
Conversation: id, user_id→User, title, created_at, updated_at
Frame: id, conversation_id→Conversation, created_at, updated_at
Message: id, role, message, thinking?, raw_input?, raw_output?, name?, frame_id→Frame, agent_id→Agent(SET NULL), created_at
Agent: id, user_id→User, name, system_prompt, voice_reference, avatar_uuid, model_name, tools(JSON), think(bool), created_at
```

## API Endpoints

All protected unless noted. Auth: `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (unprotected) |
| POST | `/login` | Auth → JWT token (unprotected) |
| POST | `/register` | Create account (unprotected) |
| POST | `/asr` | Audio → text (Whisper) |
| POST | `/chat` | Stream chat (multipart: text, model_name, conversation_id?, images?) → NDJSON |
| GET | `/models` | List LLM models |
| GET | `/conversations` | List conversations (?limit=50) |
| GET | `/conversations/{id}` | Get conversation + messages (?limit=50&offset=0) |
| POST | `/conversations/{id}` | Update title |
| DELETE | `/conversations/{id}` | Delete conversation |
| GET | `/conversations/{id}/frames` | List frames |
| GET | `/messages/{id}` | Get message |
| DELETE | `/messages/{id}` | Delete message + all subsequent in conversation |
| GET | `/messages/{id}/raw` | Get raw LLM input/output |
| GET | `/users/me` | Get profile |
| PATCH | `/users/me` | Update profile (JSON: system_prompt, preferred_name, ollama_url) |
| PATCH | `/users/me/avatars` | Update avatars (multipart) |
| POST | `/images` | Upload image → UUID |
| GET | `/images/{uuid}` | Get image (public, 1yr cache) |
| GET | `/tools` | List tools (MCP + built-in) |
| GET | `/mcp-servers` | List MCP server status |
| POST | `/tts` | Synthesize speech → WAV |
| GET | `/tts/voices` | List voices (?provider=) |
| GET | `/tts/backends` | List TTS backends |

## Environment Variables

See `.env_template`. Key vars: `POSTGRES_*`, `LLM_API_URL`, `JWT_SECRET_KEY`, `ACCESS_TOKEN_EXPIRE_DAYS=30`, `TTS_PROVIDER=gpt-sovits`, `TTS_API_URL`, `INDEX_TTS_API_URL`.

## Docker Volumes

Back up: `postgres-data`, `./data` (images/avatars/voices), `./ollama` (model cache), `./openwebui`.
