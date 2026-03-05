# Architecture

## Services

- **nginx** (80/443): HTTPS reverse proxy (self-signed certs, `proxy_buffering off` for WebSocket)
- **api** (internal 15597): Main FastAPI app (`main.py`) — chat, auth, conversations, TTS, vision
- **postgres** (internal 5432): pgvector/pgvector:pg16 (PostgreSQL 16 + vector extension, not host-exposed)
- **gpt-sovits** (9880): Voice synthesis backend
- **mediamtx** (8554): RTSP server (available for IP camera streams, not used by default webcam pipeline)

## Directory Structure

```
db/
├── models.py                # SQLAlchemy ORM models
├── session.py               # Session management (pool: 10+20 overflow, 1hr recycle, pre-ping)
└── repositories/            # Repository pattern with BaseRepository[T] generic CRUD
    ├── base.py, user.py, conversation.py, frame.py, message.py, agent.py, face.py, skill.py, mcp_server.py

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

## Key Design Principles

- **Separation of concerns**: Business logic (DB, users, prompts) in routers → pure adapters (`llm/`, `tts_adapter.py`) → provider implementations. Adapters never touch DB.
- **Repository pattern**: Repos use `with get_session()` for transactions. Use `user.id` (not username) for all DB operations.
- **Provider pattern**: LLM, TTS, and ASR all use abstract base → concrete provider → factory. Supports runtime provider selection.

## Key Patterns

### Authentication

JWT (HS256, 30-day expiry, `JWT_SECRET_KEY`). Protected endpoints use `Depends(get_authenticated_user)` → returns detached User object.

### Error Handling

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
