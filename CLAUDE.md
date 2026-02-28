# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (faster-whisper), TTS (GPT-SoVITS/INDEX-TTS), and LLM (Ollama). Microservices architecture with Docker Compose.

## Architecture

### Services

- **nginx** (80/443): HTTPS reverse proxy (self-signed certs, `proxy_buffering off` for WebSocket)
- **api** (internal 15597): Main FastAPI app (`main.py`) — chat, auth, conversations, TTS, vision
- **postgres** (internal 5432): pgvector/pgvector:pg16 (PostgreSQL 16 + vector extension, not host-exposed)
- **gpt-sovits** (9880): Voice synthesis backend
- **mediamtx** (8554): RTSP server (available for IP camera streams, not used by default webcam pipeline)

### Directory Structure

```
db/
├── models.py                # SQLAlchemy ORM models
├── session.py               # Session management (pool: 10+20 overflow, 1hr recycle, pre-ping)
└── repositories/            # Repository pattern with BaseRepository[T] generic CRUD
    ├── base.py, user.py, conversation.py, frame.py, message.py, agent.py, face.py, skill.py, mcp_server.py, mcp_server.py

models/                      # ML/inference modules (NO business logic/DB knowledge)
├── asr/                     # Pure ASR interface
│   ├── base.py              # Abstract BaseASRProvider
│   ├── faster_whisper_provider.py  # faster-whisper (CTranslate2) implementation
│   ├── adapter.py           # Pure transcription adapter
│   └── __init__.py          # Factory: get_provider(), re-exports transcribe()
├── face_recognition/        # Face detection + embedding
│   ├── base.py              # Abstract BaseFaceRecognitionProvider
│   ├── insightface_provider.py  # InsightFace (ArcFace, buffalo_l, 512-dim embeddings)
│   └── __init__.py          # Singleton factory: get_provider()
├── gesture_detection/       # Gesture detection from webcam frames
│   ├── base.py              # Abstract BaseGestureDetector
│   ├── mediapipe_provider.py  # YOLOv8-Pose (CUDA) + MediaPipe Hands (CPU)
│   ├── classifier.py        # Rule-based gesture classification (hand per-frame, pose trajectory-based)
│   └── __init__.py          # Singleton factory: get_provider()
├── llm/                     # Pure LLM interface
│   ├── base.py              # Abstract BaseLLMProvider
│   ├── ollama_provider.py   # Ollama implementation
│   ├── adapter.py           # Streaming chat, generate, list/pull models
│   └── __init__.py          # Factory: create_llm_provider(api_url)
├── tts/                     # Pure TTS interface
│   ├── base.py              # Abstract BaseTTSProvider
│   ├── gpt_sovits_provider.py  # GPT-SoVITS (path as query param, POSIX format)
│   ├── index_tts_provider.py   # INDEX-TTS (file via multipart/form-data)
│   ├── adapter.py           # synthesize, list_voices, list_backends, check_health
│   └── __init__.py          # Factory: create_tts_provider()
└── __init__.py

tools/
├── base.py                  # BaseTool abstract class (built_in flag: True = always available)
├── registry.py              # ToolRegistry, global tool_registry singleton
├── routing.py               # RouteToAgentTool, RouteToUserTool (Administrator routing, opt-in)
├── context.py               # SearchMessagesTool, GetConversationInfoTool, GetFrameSummariesTool, GetFrameMessagesTool (built-in)
├── media.py                 # PlayMusicTool, MusicControlTool, GetMusicQueueTool (opt-in)
└── skills.py                # GetSkillInstructionsTool (built-in, on-demand lookup), get_skill_names_for_user() helper

agents/
├── base.py                  # BaseAgent, SimpleAgent, AgentConfig, AgentContext
├── router.py                # RouterAgent (legacy)
├── orchestration.py         # OrchestrationSession, OrchestrationLog
└── administrator.py         # AdministratorAgent (LLM-based router)

mcp_tools/
├── client.py                # Async list_tools()/call_tool() wrappers
└── orchestrator.py          # Per-user orchestrator registry with caching (UserMCPOrchestrator)

media/                       # Media player module (yt-dlp audio streaming)
├── player.py                # MediaPlayer: per-user stateful player, yt-dlp download + base64 Opus chunk streaming
│                            # Module-level player registry: get_media_player(user_id, send_event), remove_media_player(user_id)
└── __init__.py

vision/                      # Vision frame processing pipeline
├── processor.py             # VisionProcessor: processes base64 JPEG frames for face/gesture detection
└── __init__.py

utils/prompts.py             # build_system_messages() from DEFAULT_SYSTEM_PROMPT + user prefs
utils/images.py              # Image storage: upload_image(), save_image_from_array(), check/get/delete helpers
utils/frame_summary.py       # summarize_frame() — async fire-and-forget LLM summarization of old frames
utils/memory_consolidation.py # consolidate_agent_memory() — async fire-and-forget LLM memory update from session frames
```

### Key Design Principles

- **Separation of concerns**: Business logic (DB, users, prompts) in routers → pure adapters (`llm/`, `tts_adapter.py`) → provider implementations. Adapters never touch DB.
- **Repository pattern**: Repos use `with get_session()` for transactions. Use `user.id` (not username) for all DB operations.
- **Provider pattern**: LLM, TTS, and ASR all use abstract base → concrete provider → factory. Supports runtime provider selection.

### Multi-Agent Orchestration

Two modes controlled by `event.agent_id` in `ChatRequestEvent`:

**Single Agent Mode** (`agent_id` set): Direct path — `_run_single_agent()` skips all Administrator logic. Message goes straight to the specified agent. No OrchestrationSession, no routing loop. Frontend selects agent via top-bar dropdown (persisted in localStorage); each agent maps to one conversation via `kurisu_agent_conversations` localStorage mapping. **Tool loop**: `SimpleAgent.process()` loops up to 10 rounds — after each LLM call, if tool_calls exist, executes tools, appends assistant+tool messages to context, and calls LLM again so it can reason about results or chain further tool calls.

**Group Discussion Mode** (`agent_id` null): Turn-based orchestration where **AdministratorAgent** (system-level, not a user agent) routes messages between **SimpleAgents** (user-created, equal-tier). Currently disabled in UI.

**Group Flow**: User message → Administrator selects agent → Agent responds → Administrator routes to next agent or back to user. Max 10 turns per user message. Admin model: `gemma3:4b`.

**WebSocket Events**: `TurnUpdateEvent`, `LLMLogEvent`, `AgentSwitchEvent`

**Agent message preparation** (`SimpleAgent._prepare_messages()`): Builds unified system prompt (agent identity + agent prompt + user prompt + preferred_name + timestamp + other agent descriptions). Filters out system/administrator messages from history.

**Tool access control**: All tools available by default. Built-in tools (`built_in = True`) always available regardless. `Agent.excluded_tools` JSON array lists tools to disable for that agent. `execute_tool()` enforces exclusions.

**Single WebSocket** (`/ws/chat`): All communication (chat, media, vision) flows through one WebSocket connection. No separate `/ws/media` endpoint.

**WebSocket reconnection**: Messages are persisted to DB incrementally (each complete message saved on role boundary). No server-side replay needed. `replace_websocket()` swaps socket + cancels old heartbeat + updates media player callback. On every connect/reconnect, server sends `ConnectedEvent` with full state snapshot (chat_active, conversation_id, media_state, vision_active/config). Client loads already-persisted messages from DB on reconnect, enters streaming mode if task still active, and receives remaining chunks live. Client stores use ConnectedEvent to sync: ChatWidget loads conversation + resumes streaming, visionStore re-sends vision_start if server lost state, mediaStore syncs playback state.

**Server heartbeat**: Server pings client every 30s; client responds with pong. If no pong within 10s, server closes the connection. Client auto-reconnects with exponential backoff.

**Outgoing message queue**: When WebSocket is disconnected, outgoing messages (except `vision_frame`) are queued and flushed on reconnect.

**Connection status UI**: `useConnectionStatus` hook subscribes to `wsManager.onStatusChange()`. Green/amber/red dot in MainWindow top bar.

### TTS Details

- **Voice discovery**: Scan `data/voice_storage/` for audio files. Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.
- **Text splitting**: Both providers split long text (default 200 chars) by paragraphs → sentences, merge WAV chunks.
- **Providers**: Configured via `TTS_PROVIDER` env var (default: "gpt-sovits"), overridable per-request.
- **INDEX-TTS emotion**: `emo_audio`, `emo_vector` [8 emotions], `emo_text`, `emo_alpha` (0-1).

### ASR Details

- **Provider**: faster-whisper (CTranslate2-based, much faster than HuggingFace transformers pipeline)
- **Model**: Configured via `ASR_MODEL` env var. Defaults to `data/asr/whisper-ct2` (local) or `base` (downloaded)
- **Device**: CPU by default. Override via `ASR_DEVICE` env var (`cuda`/`cpu`)
- **Lazy loading**: Model loaded on first transcription request, not at startup
- **API**: `POST /asr` accepts raw Int16 PCM bytes (`application/octet-stream`), optional `?language=` and `?mode=fast` query params. `mode=fast` uses `beam_size=1, without_timestamps=True` for faster trigger word detection.
- **Model conversion**: `python scripts/convert_whisper.py` (requires `transformers` + `torch` + `ctranslate2`)
- **Frontend**: Silero VAD (`@ricky0123/vad-web`) auto-detects speech end → sends PCM to `/asr`. Mic managed by `micStore` (Zustand) — owns ASR lifecycle + two-level interactive state (`interactiveMode` + `interactionActive`). **Typing** (default): transcript → input field as dictation, trigger word match → enables interactive mode + activates interaction + auto-sends. **Interactive idle** (`interactiveMode && !interactionActive`): call bar shown, mic listening, transcripts displayed but not sent, awaiting trigger word. Uses `mode=fast` for quicker trigger word detection. **Interactive active** (`interactiveMode && interactionActive`): all ASR auto-sends, pulse ring on mic. Activation: trigger word match. Deactivation: 30s idle after TTS+streaming finish (stays in interactive mode). Toggle via phone button in top bar. Full exit on: hang up, agent/conversation change. Sound effects on activate/deactivate, auto mic start/stop handled by micStore actions.
- **ASR optimizations**: (1) Language hint — cached in localStorage (`kurisu_asr_language`), auto-detected on first transcription, configurable in Settings. Skips faster-whisper language detection pass. (2) Fast mode — `mode=fast` uses `beam_size=1` for interactive idle trigger word detection. (3) Min duration filter — audio < 0.5s (8000 samples at 16kHz) skipped client-side.

### Tools

**Built-in tools** (`built_in = True`) — always available to all agents, cannot be excluded. `conversation_id` and `user_id` auto-injected by `execute_tool()`:
- `search_messages`: Text/regex query with date range filtering (results include `frame_id`)
- `get_conversation_info`: Conversation metadata
- `get_frame_summaries`: List past session frames with summaries, timestamps, message counts
- `get_frame_messages`: Get messages from a specific past session frame by ID
- `get_skill_instructions`: On-demand skill lookup by name (uses `user_id`)
**Non-built-in tools** — available by default, can be excluded via agent's `excluded_tools` JSON array. `_handler` auto-injected:
- `play_music`: Search YouTube and play/enqueue a track
- `music_control`: Pause, resume, skip, stop playback
- `get_music_queue`: Get current player state and queue
- `route_to_agent`, `route_to_user`: Administrator routing tools

**MCP tools** — per-user, managed via CRUD API (`/mcp-servers`). Stored in `mcp_servers` DB table. Each user has their own `UserMCPOrchestrator` with 30s tool cache. Excluded via agent's `excluded_tools` list. MCP tool schemas injected directly in `SimpleAgent.process()` (not via tool registry).

### Media Player (yt-dlp Audio Streaming)

**Architecture**: LLM tool calls and WebSocket events both access the same `MediaPlayer` instance via a per-user registry (`get_media_player(user_id, send_event)` in `media/player.py`). All media events (control + audio chunks) flow through the main `/ws/chat` WebSocket.

- **Player registry**: Module-level `_players` dict keyed by `user_id`. `get_media_player()` creates or returns existing player, updating `send_event` callback on WebSocket reconnect. Shared between chat handler and LLM tools (via `tools/media.py`).
- **Playback controls**: play, pause (asyncio.Event-based), resume, skip, stop, volume, queue management
- **Search**: yt-dlp Python API (`ytsearch`, `skip_download=True`) returns track metadata (title, URL, duration, thumbnail, artist)
- **Streaming**: aiohttp downloads audio directly from CDN URL (extracted via yt-dlp), streams 32KB base64 chunks via WebSocket. Auto-advances queue on track completion.
- **WebSocket Events (client→server)**: `MEDIA_PLAY(query)`, `MEDIA_PAUSE`, `MEDIA_RESUME`, `MEDIA_SKIP`, `MEDIA_STOP`, `MEDIA_QUEUE_ADD(query)`, `MEDIA_QUEUE_REMOVE(index)`, `MEDIA_VOLUME(volume)`
- **WebSocket Events (server→client)**: `MEDIA_STATE(state, current_track, queue, volume)`, `MEDIA_CHUNK(data, chunk_index, is_last, format, sample_rate)`, `MEDIA_ERROR(error)`
- **Dependencies**: `yt-dlp` (pip), `aiohttp` (pip)

### Skills System

User-editable instruction blocks stored in DB, injected into every agent's system prompt globally. Skills teach the LLM when/how to use capabilities (e.g., music player commands). Independent of tools — a skill can reference multiple tools.

- **Storage**: `Skill` DB model (per-user, unique name constraint). CRUD via `/skills` REST endpoints.
- **Injection**: Skill **names** listed in system prompt via `get_skill_names_for_user()`. Full instructions fetched on-demand via `get_skill_instructions` tool (registered in `tools/__init__.py`, auto-injected `user_id`).
- **Frontend**: "Skills" tab in ToolsWindow with create/edit/delete UI.

### Agent Memory

Per-agent free-form text document (markdown), automatically consolidated from conversation history and injected into the agent's system prompt every request.

- **Storage**: `Agent.memory` text column (nullable). No separate table.
- **Injection**: Appended to system prompt in `SimpleAgent._prepare_messages()` as "Your memory:\n{memory}". Loaded from `AgentConfig.memory` (no runtime DB query).
- **Consolidation**: `utils/memory_consolidation.py` — fire-and-forget async task triggered on frame idle detection (same trigger as frame summarization). Reads agent's system prompt + current memory + new frame messages, calls LLM to produce updated memory. Hard limit ~4000 chars. Uses `User.summary_model` (same model as frame summarization).
- **Trigger**: In `_run_single_agent()`, after frame summarization. Fires when `consolidation_fids` (old frame + unsummarized frames) is non-empty, `agent_id` is set, and `summary_model` is configured. Both summarization and consolidation are skipped if no summary model is set.
- **Frontend**: Editable textarea in agent edit dialog (AgentsWindow.tsx). Exposed via `GET/PATCH /agents/{id}`.

### Vision Pipeline (Face Recognition + Gesture Detection)

**Architecture**: Frontend (getUserMedia webcam capture) → WebSocket (base64 JPEG frames via backpressure, max 5 in-flight) → Backend (VisionProcessor runs face + gesture detection) → WebSocket (metadata results to frontend). Frontend renders webcam preview locally at native FPS via `<video>` element; backend never returns image data.

- **Face Recognition**: InsightFace (ArcFace, buffalo_l model, 512-dim embeddings). Lazy-loaded on first use. Models cached in `data/face_recognition/models/`. Embeddings stored in `face_photos.embedding` (pgvector `vector(512)`) with HNSW index for cosine similarity search.
- **Gesture Detection**: Provider (`mediapipe_provider.py`) only extracts raw landmarks — YOLOv8n-Pose on CUDA (17 COCO keypoints) for body pose, MediaPipe Hands on CPU (21 landmarks/hand + handedness). Returns `{pose_landmarks, hands: [{landmarks, handedness}]}`. All gesture classification lives in `VisionProcessor`: hand gestures (`thumbs_up`, `peace_sign`, `pointing`, `open_palm`) classified per-frame via `classify_hand_gestures()`, `wave` classified from **pose trajectory** via `classify_pose_trajectory()` (wrist X oscillation across 15-frame sliding window, requiring wrist-above-shoulder + ≥2 direction reversals + minimum amplitude). Models lazy-loaded/offloaded on demand via enable flags.
- **Processing**: VisionProcessor.process_frame() decodes base64 JPEG, runs face + gesture detection sequentially in thread executor. Frame dropping via `_processing` flag (skips frame if previous inference still running). In-memory face embedding cache (numpy dot product) for ~0ms matching.
- **Face Identity CRUD**: REST endpoints (`/faces`, `/faces/{id}`, `/faces/{id}/photos`). Photo uploaded → face detected → embedding stored. Photos reuse existing image storage (`data/image_storage/data/`).
- **WebSocket Events**: `VisionStartEvent` (client→server, enable_face/enable_pose/enable_hands flags), `VisionFrameEvent` (client→server, base64 JPEG), `VisionStopEvent`, `VisionResultEvent` (server→client, faces + gestures metadata only).
- **Character Animation Integration**: Gestures forwarded via IPC to character window. `CanvasCompositor` evaluates `gesture` condition type on edge transitions — matching gesture triggers pose transition. One edge per directed node pair, each containing multiple `EdgeTransition` entries (condition + videos + playback rate).

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
- Chat streams via WebSocket `StreamChunkEvent` with `conversation_id`, `frame_id`, content
- **Incremental persistence**: Each message saved to DB immediately on role boundary (not batched at end). User message → DB, then each assistant/tool message → DB as it completes. Survives server crashes mid-turn.
- User message saved to DB before agent processing begins. Final event: `DoneEvent`
- Thinking blocks: streamed as `{"content": "", "thinking": "..."}`, saved to `messages.thinking` column

### Conversation & Frame Management
- Conversations auto-created on first message with `conversation_id=None` (no explicit create endpoint)
- **Frames as session windows**: Each frame is a session window. When the user returns after idle time (`FRAME_IDLE_THRESHOLD_MINUTES`, default 30), a new frame is created with clean LLM context. The old frame gets summarized asynchronously via `summarize_frame()` if `User.summary_model` is configured (no default fallback). LLM only sees messages from the current frame. Built-in tools (`get_frame_summaries`, `get_frame_messages`) let the LLM pull past context on demand.
- Frontend shows visual separators between frames (date chip with summary tooltip)
- `GET /conversations/{id}` returns a `frames` map keyed by frame_id with metadata for frames referenced by returned messages
- Message pagination: reverse chronological fetch, reversed before return (enables infinite scroll)

### Image Handling
Stored in `data/image_storage/data/` with UUID names. Converted to base64 for LLM. Embedded as `![Image](/images/{uuid})`. Served with 1-year cache.

## Database Schema

```
User: id, username, password(bcrypt), system_prompt, preferred_name, user_avatar_uuid, agent_avatar_uuid, ollama_url, summary_model(nullable, required for summarization+memory)
Conversation: id, user_id→User, title, created_at, updated_at
Frame: id, conversation_id→Conversation, summary?, created_at, updated_at
Message: id, role, message, thinking?, raw_input?, raw_output?, name?, frame_id→Frame, agent_id→Agent(SET NULL), created_at
Agent: id, user_id→User, name, system_prompt, voice_reference, avatar_uuid, model_name, excluded_tools(JSON), think(bool), memory(text?), trigger_word(string?), created_at
FaceIdentity: id, user_id→User, name(unique per user), created_at
FacePhoto: id, identity_id→FaceIdentity(CASCADE), embedding(vector(512)), photo_uuid, created_at
Skill: id, user_id→User, name(unique per user), instructions(text), created_at
MCPServer: id, user_id→User, name(unique per user), transport_type(sse|stdio), url?, command?, args(JSON)?, env(JSON)?, enabled(bool), created_at
```

## API Endpoints

All protected unless noted. Auth: `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (unprotected) |
| POST | `/login` | Auth → JWT token (unprotected) |
| POST | `/register` | Create account (unprotected) |
| POST | `/asr` | Audio → text (faster-whisper, raw PCM, ?language=) |
| POST | `/chat` | Stream chat (multipart: text, model_name, conversation_id?, images?) → NDJSON |
| GET | `/models` | List LLM models |
| GET | `/conversations` | List conversations (?limit=50&agent_id= — with agent_id returns latest conversation for that agent) |
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
| GET | `/mcp-servers` | List user's MCP servers |
| POST | `/mcp-servers` | Create MCP server |
| PATCH | `/mcp-servers/{id}` | Update MCP server |
| DELETE | `/mcp-servers/{id}` | Delete MCP server |
| POST | `/mcp-servers/{id}/test` | Test MCP server connectivity |
| POST | `/tts` | Synthesize speech → WAV |
| GET | `/tts/voices` | List voices (?provider=) |
| GET | `/tts/backends` | List TTS backends |
| POST | `/character-assets/upload-base?agent_id=&pose_id=` | Upload base portrait → `{agent_id}/{pose_id}/base.png` |
| POST | `/character-assets/compute-patch?agent_id=&pose_id=&part=&index=` | Upload keyframe, compute diff → `{agent_id}/{pose_id}/{part}_{index}.png` |
| POST | `/character-assets/upload-video?agent_id=&edge_id=` | Upload transition video → `{agent_id}/edges/{edge_id}.mp4\|.webm` |
| GET | `/character-assets/{agent_id}/{pose_id}/{filename}` | Serve pose asset (base/patch image, no-cache) |
| GET | `/character-assets/{agent_id}/edges/{edge_id}` | Serve transition video (no-cache) |
| PATCH | `/character-assets/{agent_id}/character-config` | Update pose tree config, cleans up orphaned assets |
| POST | `/character-assets/{agent_id}/migrate-ids` | Rename asset files/folders on disk to match migrated IDs |
| GET | `/agents` | List user's agents |
| GET | `/agents/{id}` | Get agent details |
| POST | `/agents` | Create agent |
| PATCH | `/agents/{id}` | Update agent |
| PATCH | `/agents/{id}/avatar` | Update agent avatar (multipart) |
| PATCH | `/agents/{id}/voice` | Update agent voice reference (multipart) |
| DELETE | `/agents/{id}` | Delete agent |
| GET | `/agents/{id}/avatar-candidates` | Detect faces from pose base images → cropped candidate UUIDs |
| POST | `/agents/{id}/avatar-from-uuid` | Set agent avatar from existing image UUID |
| GET | `/faces` | List registered face identities (with photo count) |
| POST | `/faces` | Register new face (name + photo) → detect, embed, store |
| GET | `/faces/{id}` | Get identity details + photos |
| DELETE | `/faces/{id}` | Delete identity + all photos + disk images |
| POST | `/faces/{id}/photos` | Add additional photo to existing identity |
| DELETE | `/faces/{id}/photos/{photo_id}` | Remove a specific photo |
| GET | `/faces/{id}/photos/{photo_id}/image` | Serve photo image file |
| GET | `/skills` | List user's skills |
| POST | `/skills` | Create skill (name, instructions) |
| PATCH | `/skills/{id}` | Update skill |
| DELETE | `/skills/{id}` | Delete skill |

## Environment Variables

See `.env_template`. Key vars: `POSTGRES_*`, `LLM_API_URL`, `JWT_SECRET_KEY`, `ACCESS_TOKEN_EXPIRE_DAYS=30`, `TTS_PROVIDER=gpt-sovits`, `TTS_API_URL` (hardcoded in docker-compose as `http://gpt-sovits-container:9880`), `INDEX_TTS_API_URL`, `ASR_MODEL=data/asr/whisper-ct2`, `ASR_DEVICE=auto`, `FRAME_IDLE_THRESHOLD_MINUTES=30`. MCP tool-specific env vars (e.g. `SERPAPI_KEY`) are configured in each tool's own `.env` in the separate `mcp-servers` repo.

## Docker Volumes

Back up: `postgres-data`, `./data` (images/avatars/voices), `./ollama` (model cache), `./openwebui`.
