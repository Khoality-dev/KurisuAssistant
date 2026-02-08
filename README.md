# Kurisu Assistant

A voice-based AI assistant platform combining STT, TTS, and LLM with a microservices architecture.

## Overview

Kurisu Assistant combines:

* **Speech-to-Text** via faster-whisper (CTranslate2) for fast, accurate transcription
* **Text-to-Speech** via GPT-SoVITS and INDEX-TTS for natural voice output
* **Large Language Models** via Ollama for intelligent, context-aware conversations
* **Multi-Agent Orchestration** with an Administrator routing between specialized agents

## Architecture

| Service | Port | Description |
|---------|------|-------------|
| **nginx** | 80/443 | HTTPS reverse proxy (self-signed certs) |
| **api** | 15597 (internal) | FastAPI backend — chat, auth, ASR, TTS, agents |
| **postgres** | 5432 (internal) | PostgreSQL 16 |
| **gpt-sovits** | 9880 | Voice synthesis backend |

### Key Modules

```
asr/            # ASR provider pattern (faster-whisper)
llm/            # LLM provider pattern (Ollama)
tts_providers/  # TTS provider pattern (GPT-SoVITS, INDEX-TTS)
agents/         # Multi-agent orchestration (Administrator + SimpleAgents)
tools/          # Built-in tools (context search, routing)
mcp_tools/      # Custom MCP tool servers
routers/        # FastAPI route handlers
db/             # SQLAlchemy models + repository pattern
```

## Features

* **Voice Input**: Browser-based Silero VAD auto-detects speech, transcribes via server-side faster-whisper
* **Multi-Agent Chat**: Administrator agent routes between user-created agents with tool access control
* **Streaming Responses**: WebSocket-based real-time streaming with reconnection support
* **TTS Auto-Play**: Streaming TTS plays audio as the agent is still responding
* **Image Support**: Upload and embed images in conversations
* **MCP Tools**: Extensible tool system via Model Context Protocol

## Installation

### Server (Docker)

```bash
docker-compose up -d
```

### Server (Local Development)

```bash
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt
python migrate.py          # Run database migrations
./run_dev.bat              # Start server (Windows)
```

### ASR Model Setup

The server ships with a base Whisper model. To use a finetuned model:

```bash
# Requires transformers + torch + ctranslate2 for conversion
pip install transformers torch ctranslate2
python scripts/convert_whisper.py --model whisper-finetuned --output data/asr/whisper-ct2
```

### Client (Electron + React)

See the [KurisuAssistant-Client-Windows](https://github.com/Khoality-dev/KurisuAssistant-Client-Windows) repo.

```bash
npm install
npm run electron:dev
```

## Configuration

Key environment variables (see `.env_template`):

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `POSTGRES_*` | `kurisu` | Database credentials |
| `JWT_SECRET_KEY` | - | Secret for JWT tokens |
| `TTS_PROVIDER` | `gpt-sovits` | Default TTS backend |
| `ASR_MODEL` | `data/asr/whisper-ct2` | Whisper model path or size |
| `ASR_DEVICE` | `cpu` | ASR device (`cpu`/`cuda`) |

## Database

Managed with Alembic. Migrations auto-run on Docker startup.

```bash
cd db && alembic revision --autogenerate -m "description"  # Create migration
python migrate.py                                           # Apply migrations
```

Default seed: `admin:admin` account.

## API Endpoints

All protected unless noted. Auth: `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/login` | Auth (unprotected) |
| POST | `/register` | Create account (unprotected) |
| POST | `/asr` | Audio transcription (raw PCM) |
| POST | `/tts` | Speech synthesis |
| GET | `/models` | List LLM models |
| GET/DELETE | `/conversations` | Conversation management |
| GET/DELETE | `/messages/{id}` | Message operations |
| PATCH | `/users/me` | Update profile |
| GET | `/tools` | List available tools |

Chat is handled via WebSocket at `/ws`.

## License

MIT License. See [LICENSE](LICENSE).

## Acknowledgments

* [faster-whisper](https://github.com/SYSTRAN/faster-whisper) for CTranslate2-based Whisper
* [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) for voice synthesis
* [Ollama](https://ollama.ai) for local LLM serving
* [Silero VAD](https://github.com/snakers4/silero-vad) for voice activity detection
