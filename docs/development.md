# Development

## Local Setup

```bash
python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
python migrate.py          # Run migrations
./run_dev.bat              # Start server (Windows)
```

## Docker

```bash
docker-compose up -d       # Start all services
docker-compose logs -f api # View API logs
```

Migrations auto-run on container startup via `docker-entrypoint.sh`.

## Environment Variables

See `.env_template` for all options.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_*` | `kurisu` | Database credentials |
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `JWT_SECRET_KEY` | — | Secret for JWT tokens |
| `ACCESS_TOKEN_EXPIRE_DAYS` | `30` | JWT token expiry |
| `TTS_PROVIDER` | `gpt-sovits` | TTS backend (`gpt-sovits` or `index-tts`) |
| `TTS_API_URL` | (docker-compose) | GPT-SoVITS API URL (hardcoded as `http://gpt-sovits-container:9880` in docker-compose) |
| `INDEX_TTS_API_URL` | — | INDEX-TTS API URL |
| `ASR_MODEL` | `data/asr/whisper-ct2` | Whisper model path or size |
| `ASR_DEVICE` | `auto` | ASR inference device (`cpu`/`cuda`) |
| `FRAME_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before starting a new session frame |

MCP tool-specific env vars (e.g. `SERPAPI_KEY`) are configured in each tool's own `.env` in the separate `mcp-servers` repo.

## Docker Volumes

Back up these volumes/directories:

- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets
- `./ollama` — Ollama model cache
- `./openwebui` — Open WebUI data

## Voice Files

Place voice reference files in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Default Account

First migration seeds an `admin:admin` account.
