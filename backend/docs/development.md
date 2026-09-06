# Development

Everything below runs from the `backend/` directory. The server resolves `data/` relative to the working directory, and `docker compose` reads `docker-compose.yml` from here.

## Local Setup

```bash
python -m venv venv && source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m scripts.migrate                          # Run migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
```

## Docker

```bash
docker compose up -d       # Start all services
docker compose logs -f api # View API logs
```

Migrations auto-run on container startup via `docker-entrypoint.sh`. The image carries the application code — the Dockerfile copies `kurisuassistant/` and `scripts/` in — and the only thing the API container mounts from this directory is `data/`, which is runtime state. So a code change reaches the container through `docker compose up -d --build`, not by editing the checkout. To edit without rebuilding, use the dev overlay below: it mounts the source back over the image's copy.

## Releases and Deployment

There is no long-lived `dev` branch. Work happens on short-lived branches merged into `main` through pull requests, and a release is a tag on `main`: `backend-vX.Y.Z`, with X.Y.Z equal to `__version__` in `version.py`. The tag *is* the release — nothing else marks one, and the backend has no publish workflow. A deployment is a checkout of a release tag with `docker compose up -d --build` run from its `backend/`.

Keep a deployment's checkout separate from the one you develop in. The checkout is a build context, an env file and a `data/` directory — the running code comes from the image, so editing the tree changes nothing until the next `--build`, and the image keeps running if the tree moves. What still makes a shared tree a bad idea is `data/` and the fixed project name: a second stack started from the same directory writes into the same user data. Move a deployment with checkout and rebuild in one step:

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

Unlike the plain stack, the overlay mounts `./kurisuassistant`, `./scripts`, `./tests` and `./pytest.ini` over the image's copy, so an edit takes effect on `docker compose -f docker-compose.dev.yml restart api` and `pytest` can run inside the container. That is also why it must be run from a checkout that is not also running the plain stack: the two would share `./data`, and the overlay would be editing the code of a tree a deployment builds from. It publishes no port and is not part of any reverse-proxy setup; reach it on the Docker network, or add a `ports:` mapping while you need it. See the file's header for what is and is not shared.

## Tests

```bash
pytest -m "not integration"                          # what CI runs: unit + mock-Ollama + (with Postgres) db tests
POSTGRES_HOST=localhost POSTGRES_PORT=55432 pytest -m db   # migrations + system tests against a throwaway Postgres
pytest -m integration                                # a live Ollama / paid provider — by hand only, it costs money
```

Three markers, registered in `pytest.ini`:

- **unmarked** — pure unit tests, no services.
- **`db`** — needs Postgres: the migration tests and the *system tests* (`tests/test_system_chat.py`), which run the real app on a fresh database created for the session, log in as the seeded `admin`, open `/ws/chat` and drive whole turns — streaming, thinking, the tool loop with its approval gate, compaction — with the model played by the mock Ollama. CI provides Postgres (`backend-test.yml`); locally they skip unless `POSTGRES_HOST`/`POSTGRES_PORT` point at one. A throwaway is `docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_USER=kurisu -e POSTGRES_PASSWORD=kurisu -e POSTGRES_DB=kurisu pgvector/pgvector:pg16`.
- **`integration`** — needs a real external service. Never runs in CI: a live model call costs money on a paid provider and needs a GPU otherwise.

### Mock Ollama

`tests/mock_ollama/` is an Ollama that answers deterministically: `GET /api/tags`, `POST /api/show|pull|chat|generate`, `DELETE /api/delete`, served to the real `ollama` client so its pydantic parsing is exercised. With nothing scripted, `/api/chat` echoes `You said: <message>` a word per chunk, adds a `thinking` chunk when `think` is set, turns `call <tool> {json}` into a tool call when that tool was offered, and acknowledges a `tool` message with `The tool returned: …`. Tests script exact replies — content, thinking, tool calls, chunking, delay, or an HTTP error — with `mock_ollama.state.script(Reply(...))` and assert on `mock_ollama.state.requests_to("/api/chat")`; the `mock_ollama` fixture (`conftest.py`) resets it between tests.

It is also a plain process, for driving a client against a real backend that needs no GPU or paid model — two terminals, no containers:

```bash
python -m tests.mock_ollama --port 11435                                        # the model
LLM_API_URL=http://127.0.0.1:11435 uvicorn kurisuassistant.main:app --port 15597 # the backend, pointed at it
```

Script it over HTTP: `POST /_mock/replies {"replies": [{"content": "..."}]}`, `GET /_mock/requests`, `DELETE /_mock/requests`, `POST /_mock/reset`, `GET /_mock/state`. (For a backend running in Docker, `LLM_API_URL=http://host.docker.internal:11435` reaches a mock on the host.)

## Environment Variables

`.env.template` lists the variables the Compose stack expects. Variables read by the server itself:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | — | Database connection |
| `LLM_API_URL` | `http://localhost:11434` | Ollama server URL |
| `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `POE_API_KEY` | — | Cloud LLM providers; fallbacks when the user has no key stored |
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
