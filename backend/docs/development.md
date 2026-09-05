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

## Dev Deployment

A second, isolated copy of the API runs next to production from its own checkout, with its own database and `data/` directory. It shares the GPU services (universal-voice, vixtts, gpt-sovits) and Ollama with production; the API uploads the voice reference with every TTS request, so nothing user-specific lives in those services.

| | Production | Dev |
|---|---|---|
| Checkout | `KurisuAssistant-prod/` — git worktree, detached at a `backend-vX.Y.Z` tag | `KurisuAssistant/` — `main`, the working checkout; the overlay runs from here |
| Compose project | `kurisuassistant` | `kurisuassistant-dev` |
| API container | `kurisu-api` | `kurisu-api-dev` |
| Database | `postgres-container`, volume `kurisuassistant_postgres-data` | `postgres-dev`, volume `kurisuassistant-dev_postgres-data` |
| Data | `KurisuAssistant-prod/backend/data/` | `KurisuAssistant/backend/data/` |
| URL | `https://<host>:15597` | `https://<host>:15598` |

Setup, once:

```bash
# production — from the monorepo root, once
git worktree add --detach ../KurisuAssistant-prod backend-vX.Y.Z
cd ../KurisuAssistant-prod/backend
#   put the .env with the database credentials here — this is its home; the main
#   checkout does not keep one
mkdir -p data                                       # or move the existing data/ here
docker compose up -d --build

# a second instance to try main against — from KurisuAssistant/backend, never from -prod
cp ../../KurisuAssistant-prod/backend/.env .        # same credentials, separate database
docker compose -f docker-compose.dev.yml up -d --build
```

There is no long-lived `dev` branch, and no branch for production either. Work happens on short-lived branches merged into `main` through pull requests; `main` is the only line of development, and `KurisuAssistant/` — this checkout — is where it happens. Production is a second worktree, `KurisuAssistant-prod/`, detached at a release tag:

- **Production** runs a release. Tag `main` as `backend-vX.Y.Z`, with X.Y.Z equal to `__version__` in `version.py`, then in `KurisuAssistant-prod/backend`: `git fetch --tags && git checkout backend-vX.Y.Z && docker compose up -d --build`. The tag *is* the release; nothing else marks one, and there is no publish workflow for the backend. `docker-compose.yml` pins `name: kurisuassistant`, so the project adopts the same containers and volumes whichever directory it is started from.
- **Dev** is `main` itself. Run the tests here. To try `main` against a running instance, the overlay starts a second one from this same directory — `docker compose -f docker-compose.dev.yml up -d --build` — as its own project (`kurisuassistant-dev`) with its own database and `data/`. Never run the overlay from `KurisuAssistant-prod/`.

Checkout and restart belong in the same step. The API bind-mounts `./kurisuassistant`, so a bare `git checkout` changes the running container's code on disk immediately, and a process still running on its old imports can then lazy-load modules from the new commit. Never move a deployment's checkout without restarting its container in the same command. Migrations run on container start, so the restart is also what applies them.

When a release bumps `WIRE_PROTOCOL`, publish the client releases first — `android-v*` and `desktop-v*` tags trigger the publish workflows — and deploy the backend tag after. The backend rejects a mismatched client with 426 and Android hard-gates on it, so deploying first locks every installed app out.

The vhost is `../ingress/nginx/conf.d/kurisu-dev.conf`. See `docker-compose.dev.yml` for what is and is not shared.

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
| `CONVERSATION_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before a conversation's memory is consolidated |
| `MCP_TLS_VERIFY` | `true` | Set to `false` to skip TLS verification on server-side MCP connections |
| `ALLOW_REGISTRATION` | — | Registration is closed unless this says otherwise |
| `VIXTTS_ROOT`, `UVOICE_ROOT` | (docker-compose) | Sibling checkouts used as build contexts and mounts for the TTS and ASR services |

There is **no `DATA_DIR` variable**. `core/paths.py` resolves `data/` from the package location and never reads the environment, which is why every command has to be run from `backend/`.

MCP tool-specific env vars (e.g. `SERPAPI_KEY`) are configured in each tool's own `.env` in the separate `mcp-servers` repo.

## Docker Volumes

Back up these volumes/directories:

- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets, JWT secret

## Voice Files

Place voice reference files in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Default Account

First migration seeds an `admin:admin` account.
