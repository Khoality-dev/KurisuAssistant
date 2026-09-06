# Kurisu Assistant — Backend

The API server behind the [desktop](../clients/desktop/) and [Android](../clients/android/) clients. Text chat, tools, and memory run in the base Docker Compose stack; speech services are optional. Part of the [KurisuAssistant monorepo](../README.md).

## Features

- **Voice Conversations** — Clients run Silero VAD and send audio; the server transcribes it and answers with streamed text and TTS (GPT-SoVITS or viXTTS)
- **One Assistant, Many Personas** — One assistant per account owns the model, tools, memory and voice wake word; personas own the name, prompt, voice and face, and a conversation binds to one. Task-only sub-agents with their own models can be delegated to mid-answer
- **Assistant Memory** — Idle conversations are consolidated into one persistent memory document per account, shared by every persona and injected into later requests
- **Rolling Context Compaction** — Long conversations are summarized in place once they approach the model's context window
- **Vision Pipeline** — Face recognition (InsightFace) and gesture detection (YOLOv8-Pose + MediaPipe Hands) from client camera frames
- **Character Animation** — Pose-based character configuration with gesture-triggered transitions
- **Skills System** — User-editable instruction blocks that teach the assistant how to use capabilities
- **Tool Ecosystem** — Built-in tools and MCP tools (server and client side), with server-enforced approval policies
- **Image Support** — Images in conversations with vision model support

## Prerequisites

- Docker Engine 24 or newer and Docker Compose v2.24 or newer
- [Ollama](https://ollama.ai) reachable from the stack, or a cloud provider key (Gemini, NVIDIA NIM, or Poe)

No GPU or external checkout is required for the base stack. The optional `voice` profile requires an NVIDIA GPU, the NVIDIA container runtime, and external viXTTS and universal-asr trees. See the [voice manual](../docs/manual/voice.md).

## Getting Started

From the monorepo root:

```bash
cd backend
cp .env.template .env    # Edit with your settings
docker compose up -d
curl localhost:15597/health
```

The health check should return `{"status":"ok","service":"llm-hub"}`. Clients connect to `http://<server-address>:15597`.

Default account: `admin` / `admin`. Migrations run automatically on container start (`docker-entrypoint.sh`). There is currently no way to change the default admin password, so do not expose a fresh server on an untrusted network. Before the first message, select a model in the **Assistant** screen. See [First run](../docs/manual/first-run.md).

### Local Development

```bash
python -m venv venv && source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m scripts.migrate                          # Run database migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
```

Run these development commands from this directory. Runtime `data/` is resolved from the backend package location, not the shell's current working directory.

## Configuration

Environment variables read by the server (see `.env.template` for the full list used by the Compose stack):

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | — | Database connection |
| `API_PORT`, `API_BIND` | `15597`, `0.0.0.0` | Published HTTP port and bind address |
| `HTTPS_PORT` | `443` | Port used by the optional TLS profile |
| `LLM_API_URL` | `http://host.docker.internal:11434` | Ollama server URL as reached from the API container |
| `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `POE_API_KEY` | — | Optional cloud-provider fallbacks when a user has not stored a key in the app |
| `ASR_API_URL`, `UVOICE_URL` | (docker-compose) | Speech recognition / universal voice service |
| `JWT_SECRET_KEY` | generated | Overrides the secret persisted to `data/jwt_secret.key` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime |
| `CONVERSATION_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before a conversation's memory is consolidated |
| `MCP_TLS_VERIFY` | `true` | Set to `false` to skip TLS verification on server-side MCP connections |
| `ALLOW_REGISTRATION` | `false` | Registration is closed unless this is enabled |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Login and registration attempts allowed per client address and window; `0` disables the limit |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `300` | Authentication rate-limit window |

There is no `DATA_DIR` variable: `data/` is resolved from the backend package location. Compose bind-mounts this checkout's `data/` at that location in the container.

MCP tool servers are configured per user through `/mcp-servers` and stored in the database, not in a file. See [docs/mcp-config.md](docs/mcp-config.md).

Voice reference files go in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Backup & Restore

The database, `data/`, and `.env` must be captured and restored as one unit. The named database volume is `kurisuassistant_postgres-data`. Follow the complete, ordered [backup and restore procedure](../docs/manual/backup-and-restore.md); restoring mismatched database and file state can delete persona assets.

## Documentation

See the [docs/](docs/) directory:

- [Architecture](docs/architecture.md), [Assistant internals](docs/agents.md), [WebSocket](docs/websocket.md), [API Reference](docs/API.md)
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
