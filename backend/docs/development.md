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

## Releases and Deployment

There is no long-lived `dev` branch. Work happens on short-lived branches merged into `main` through pull requests, and a release is a tag on `main`: `backend-vX.Y.Z`, with X.Y.Z equal to `__version__` in `version.py`. The tag *is* the release — nothing else marks one, and the backend has no publish workflow. A deployment is a checkout of a release tag with `docker compose up -d --build` run from its `backend/`.

Keep a deployment's checkout separate from the one you develop in. The API container bind-mounts `./kurisuassistant`, `./scripts` and `./data` from the directory it was started from, so that working tree *is* the running code: editing or checking out in a deployment's tree changes the live server immediately, and a process still on its old imports can lazy-load modules from the new commit. Move a deployment with checkout and restart in one step:

```bash
git fetch --tags && git checkout backend-vX.Y.Z && docker compose up -d --build
```

Migrations run on container start, so the restart is also what applies them. `docker-compose.yml` pins `name: kurisuassistant`, so the project adopts the same containers and volumes (`postgres-container`, `kurisuassistant_postgres-data`) whichever directory it is started from — a checkout under a new path continues the same database instead of silently creating an empty one.

When a release bumps `WIRE_PROTOCOL`, publish the client releases first — `android-v*` and `desktop-v*` tags trigger the publish workflows — and deploy the backend tag after. The backend rejects a mismatched client with 426 and Android hard-gates on it, so deploying first locks every installed app out.

### A second instance

`docker-compose.dev.yml` starts a second, isolated API and database as its own Compose project — `kurisuassistant-dev`: `kurisu-api-dev`, `postgres-dev`, volume `kurisuassistant-dev_postgres-data`, its own `./data` — for trying `main` against a running backend without touching a deployment. It shares the GPU services (universal-voice, vixtts, gpt-sovits) and Ollama with the deployment over the deployment's Compose network; the API uploads the voice reference with every TTS request, so nothing user-specific lives in those services.

```bash
# from the backend/ of the checkout you want to run — never the deployment's
cp /path/to/deployment/backend/.env .     # same credentials, separate database
docker compose -f docker-compose.dev.yml up -d --build
```

It publishes no port and is not part of any reverse-proxy setup; reach it on the Docker network, or add a `ports:` mapping while you need it. Run the overlay only from a checkout that is not also running the plain stack: both bind-mount the same `./kurisuassistant` and `./data`, so two projects sharing one directory would run the same code against the same files. See the file's header for what is and is not shared.

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
