# Kurisu Assistant — Backend

The API server behind the [desktop](../clients/desktop/) and [Android](../clients/android/) clients. Speech recognition, voice synthesis, and LLM agents with tools and memory, run as a Docker Compose stack. Part of the [KurisuAssistant monorepo](../README.md).

## Features

- **Voice Conversations** — Clients run Silero VAD and send audio; the server transcribes it and answers with streamed text and TTS (GPT-SoVITS or viXTTS)
- **One Assistant, Many Personas** — One assistant per account owns the model, tools, memory and voice wake word; personas own the name, prompt, voice and face, and a conversation binds to one. Task-only sub-agents with their own models can be delegated to mid-answer
- **Assistant Memory** — Idle conversations are consolidated into one persistent memory document per account, shared by every persona and injected into later requests
- **Rolling Context Compaction** — Long conversations are summarized in place once they approach the model's context window
- **Vision Pipeline** — Face recognition (InsightFace) and gesture detection (YOLOv8-Pose + MediaPipe Hands) from client camera frames
- **Character Animation** — Pose-based character configuration with gesture-triggered transitions
- **Skills System** — User-editable instruction blocks that teach agents how to use capabilities
- **Tool Ecosystem** — Built-in tools and MCP tools (server and client side), with server-enforced approval policies
- **Image Support** — Images in conversations with vision model support

## Prerequisites

- Docker and Docker Compose with the NVIDIA container runtime (the API, TTS, and ASR services reserve GPUs)
- [Ollama](https://ollama.ai) reachable from the stack, or a cloud provider key (Gemini, NVIDIA)
- Sibling checkouts of the TTS and ASR services referenced by `docker-compose.yml` (`VIXTTS_ROOT`, `UVOICE_ROOT`)

## Getting Started

```bash
cp .env_template .env    # Edit with your settings
docker compose up -d
docker compose logs -f api
```

Default account: `admin` / `admin`. Migrations run automatically on container start (`docker-entrypoint.sh`).

### Local Development

```bash
python -m venv venv && source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m scripts.migrate                          # Run database migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
```

`run_dev.bat` wraps the same steps for Windows. Run everything from this directory: the server resolves `data/` relative to the working directory.

## Configuration

Environment variables read by the server (see `.env_template` for the full list used by the Compose stack):

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | — | Database connection |
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `GEMINI_API_KEY`, `NVIDIA_API_KEY` | — | Cloud LLM providers (per-user keys can also be stored in the app) |
| `ASR_API_URL`, `UVOICE_URL` | (docker-compose) | Speech recognition / universal voice service |
| `JWT_SECRET_KEY` | generated | Overrides the secret persisted to `data/jwt_secret.key` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime |
| `CONVERSATION_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before a conversation's memory is consolidated |
| `MCP_TLS_VERIFY` | `true` | Set to `false` to skip TLS verification on server-side MCP connections |
| `ALLOW_REGISTRATION` | — | Registration is closed unless this says otherwise |

There is no `DATA_DIR` variable: `data/` is resolved from the package location, which is why every command runs from this directory.

MCP tool servers are configured per user through `/mcp-servers` and stored in the database, not in a file. See [docs/mcp-config.md](docs/mcp-config.md).

Voice reference files go in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Backup & Restore

Back up these volumes and directories:

- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets, JWT secret

## Documentation

See the [docs/](docs/) directory:

- [Architecture](docs/architecture.md), [Agents](docs/agents.md), [WebSocket](docs/websocket.md), [API Reference](docs/API.md)
- [TTS](docs/tts.md), [ASR](docs/asr.md), [Vision](docs/vision.md), [GPT-SoVITS Setup](docs/gpt-sovits.md)
- [Tools](docs/tools.md), [Skills](docs/skills.md), [MCP Configuration](docs/mcp-config.md)
- [Database](docs/database.md), [Development](docs/development.md)

## Acknowledgments

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2-based Whisper
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — Voice synthesis
- [viXTTS](https://huggingface.co/capleaf/viXTTS) — Vietnamese voice-cloning TTS
- [Ollama](https://ollama.ai) — Local LLM serving
- [Silero VAD](https://github.com/snakers4/silero-vad) — Voice activity detection
- [InsightFace](https://github.com/deepinsight/insightface) — Face recognition
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) — Hand tracking
