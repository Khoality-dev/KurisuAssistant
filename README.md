# Kurisu Assistant

A voice-based AI assistant platform combining speech recognition, voice synthesis, and large language models. Built with a microservices architecture using Docker Compose.

## Features

- **Voice Conversations** — Browser-based Silero VAD detects speech, transcribes via faster-whisper, and responds with natural TTS (GPT-SoVITS or INDEX-TTS)
- **Multi-Agent System** — Create specialized agents with custom prompts, voices, models, and tool access. Administrator agent can route between them in group discussions
- **Agent Memory** — Agents automatically consolidate conversation history into persistent memory, injected into every request
- **Vision Pipeline** — Real-time face recognition (InsightFace) and gesture detection (YOLOv8-Pose + MediaPipe Hands) from webcam
- **Character Animation** — Pose-based character system with gesture-triggered transitions
- **Session Frames** — Conversations split into session windows after idle periods, with automatic LLM summarization of past frames
- **Skills System** — User-editable instruction blocks that teach agents how to use capabilities
- **Tool Ecosystem** — Built-in tools (message search, web search, frame history), opt-in tools, and custom MCP tools
- **Image Support** — Upload and embed images in conversations with vision model support

## Architecture

| Service | Port | Description |
|---------|------|-------------|
| **nginx** | 80/443 | HTTPS reverse proxy |
| **api** | 15597 (internal) | FastAPI backend |
| **postgres** | 5432 (internal) | PostgreSQL 16 + pgvector |
| **gpt-sovits** | 9880 | Voice synthesis |

```
models/          ML providers (ASR, LLM, TTS, face recognition, gesture detection)
agents/          Multi-agent orchestration
tools/           Built-in and opt-in tool definitions
mcp_tools/       Custom MCP tool servers
vision/          Webcam frame processing pipeline
routers/         FastAPI route handlers
db/              SQLAlchemy models + repository pattern
utils/           Prompts, images, frame summarization, memory consolidation
```

## Getting Started

### Prerequisites

- Docker and Docker Compose
- [Ollama](https://ollama.ai) with at least one model pulled
- (Optional) NVIDIA GPU for CUDA-accelerated ASR and vision

### Docker

```bash
cp .env_template .env    # Edit with your settings
docker compose up -d
```

### Local Development

```bash
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt
python migrate.py        # Run database migrations
./run_dev.bat            # Start server (Windows)
```

### Client

See [KurisuAssistant-Client-Windows](https://github.com/Khoality-dev/KurisuAssistant-Client-Windows) for the Electron + React desktop client.

### Default Account

First migration seeds an `admin:admin` account.

## Configuration

Key environment variables (see `.env_template` for all options):

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `POSTGRES_*` | `kurisu` | Database credentials |
| `JWT_SECRET_KEY` | - | Secret for JWT tokens |
| `TTS_PROVIDER` | `gpt-sovits` | TTS backend (`gpt-sovits` or `index-tts`) |
| `ASR_MODEL` | `data/asr/whisper-ct2` | Whisper model path or size |
| `ASR_DEVICE` | `auto` | ASR inference device (`cpu`/`cuda`) |
| `FRAME_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before starting a new session frame |

## Backup & Restore

The `userdata/` directory contains backup tooling:

- `kurisu_db_backup.dump` — PostgreSQL database dump
- `data.tar` — User data (images, voices, character assets)
- `RESTORE.md` — Step-by-step restore instructions

## Database

Managed with Alembic. Migrations auto-run on Docker startup.

```bash
cd db && alembic revision --autogenerate -m "description"
python migrate.py
```

## API

All endpoints require JWT authentication (`Authorization: Bearer <token>`) unless noted. Chat uses WebSocket at `/ws/chat`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/login` | Auth (public) |
| POST | `/register` | Create account (public) |
| POST | `/asr` | Speech-to-text (raw PCM) |
| POST | `/tts` | Text-to-speech |
| GET | `/models` | List LLM models |
| - | `/conversations/*` | CRUD conversations, frames, messages |
| - | `/agents/*` | CRUD agents, avatar generation |
| - | `/faces/*` | Face identity management |
| - | `/skills/*` | Skill management |
| - | `/character-assets/*` | Pose tree assets and config |
| - | `/users/me` | Profile and avatars |
| GET | `/tools` | List available tools |
| GET | `/images/{uuid}` | Serve image (public) |

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2-based Whisper
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — Voice synthesis
- [INDEX-TTS](https://github.com/indexteam/index-tts) — Voice synthesis
- [Ollama](https://ollama.ai) — Local LLM serving
- [Silero VAD](https://github.com/snakers4/silero-vad) — Voice activity detection
- [InsightFace](https://github.com/deepinsight/insightface) — Face recognition
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) — Hand tracking
