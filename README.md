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
- **Tool Ecosystem** — Built-in tools (message search, frame history), opt-in tools (music player), and custom MCP tools (server + client-side)
- **Media Player** — YouTube audio streaming via yt-dlp, controllable by voice or LLM tools
- **Image Support** — Upload and embed images in conversations with vision model support

## Prerequisites

- Docker and Docker Compose
- [Ollama](https://ollama.ai) with at least one model pulled
- (Optional) NVIDIA GPU for CUDA-accelerated ASR and vision

## Getting Started

```bash
cp .env_template .env    # Edit with your settings
docker compose up -d
```

Default account: `admin` / `admin`

### Local Development

```bash
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt
python migrate.py        # Run database migrations
./run_dev.bat            # Start server (Windows)
```

## Client

See [KurisuAssistant-Client-Windows](https://github.com/Khoality-dev/KurisuAssistant-Client-Windows) for the Electron + React desktop client.

## Configuration

Key environment variables (see `.env_template` for all options):

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `POSTGRES_*` | `kurisu` | Database credentials |
| `JWT_SECRET_KEY` | — | Secret for JWT tokens |
| `TTS_PROVIDER` | `gpt-sovits` | TTS backend (`gpt-sovits` or `index-tts`) |
| `ASR_MODEL` | `data/asr/whisper-ct2` | Whisper model path or size |
| `ASR_DEVICE` | `auto` | ASR inference device (`cpu`/`cuda`) |
| `FRAME_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before starting a new session frame |

Voice reference files go in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Backup & Restore

Back up these volumes/directories:
- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets
- `./ollama` — Ollama model cache

The `userdata/` directory contains backup tooling — see `userdata/RESTORE.md` for step-by-step instructions.

## Documentation

See the [docs/](docs/) directory for detailed technical documentation:
- [Architecture](docs/architecture.md), [Agents](docs/agents.md), [WebSocket](docs/websocket.md), [API Reference](docs/API.md)
- [TTS](docs/tts.md), [ASR](docs/asr.md), [Vision](docs/vision.md), [Media Player](docs/media.md)
- [Tools & Skills](docs/tools.md), [Database](docs/database.md), [Development](docs/development.md)

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
