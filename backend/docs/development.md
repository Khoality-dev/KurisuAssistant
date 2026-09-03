# Development

Everything below runs from the `backend/` directory. The server resolves `data/` relative to the working directory, and `docker compose` reads `docker-compose.yml` from here.

## Local Setup

```bash
python -m venv venv && source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m scripts.migrate                          # Run migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
```

`run_dev.bat` does the same on Windows (creates the venv, runs migrations, starts uvicorn); `stop_dev.bat` kills whatever is listening on port 15597.

## Docker

```bash
docker compose up -d       # Start all services
docker compose logs -f api # View API logs
```

Migrations auto-run on container startup via `docker-entrypoint.sh`. The API container mounts `kurisuassistant/`, `scripts/`, `tests/`, and `data/` from this directory.

## Tests

```bash
pytest                       # unit tests
pytest -m integration        # tests that need Postgres / Ollama
```

## Environment Variables

`.env_template` lists the variables the Compose stack expects. Variables read by the server itself:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | — | Database connection |
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `GEMINI_API_KEY`, `NVIDIA_API_KEY` | — | Cloud LLM providers |
| `ASR_API_URL`, `UVOICE_URL` | (docker-compose) | Speech recognition / universal voice service |
| `JWT_SECRET_KEY` | generated | Overrides the secret persisted to `data/jwt_secret.key` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime |
| `CONVERSATION_IDLE_THRESHOLD_MINUTES` | — | Idle time before a conversation's memory is consolidated |
| `DATA_DIR` | `data/` | Override the data directory |
| `VIXTTS_ROOT`, `UVOICE_ROOT` | (docker-compose) | Sibling checkouts used as build contexts and mounts for the TTS and ASR services |

MCP tool-specific env vars (e.g. `SERPAPI_KEY`) are configured in each tool's own `.env` in the separate `mcp-servers` repo.

## Docker Volumes

Back up these volumes/directories:

- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets, JWT secret

## Voice Files

Place voice reference files in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Default Account

First migration seeds an `admin:admin` account.
