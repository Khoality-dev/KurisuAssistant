# Development

Everything below runs from the `backend/` directory, because `docker compose` reads `docker-compose.yml` from here. `data/` is not why: the server resolves it from the installed package's location (`core/paths.py`), so it is always the `data/` beside `kurisuassistant/`, wherever you started the process.

## Local Setup

```bash
python -m venv venv && source venv/bin/activate   # venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m scripts.migrate                          # Run migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
```

## Docker

```bash
docker compose up -d       # API + database, published on API_PORT (15597)
docker compose logs -f api # View API logs
curl localhost:15597/health
```

That is the whole stack for text chat. There are two Compose files in the
project — this one and `docker-compose.dev.yml` — and everything optional is a
profile inside the first:

| Profile | Adds | Needs |
| --- | --- | --- |
| `whisper` | recognition: a published Whisper ASR webservice, one model per container | an NVIDIA runtime, and disk for the model it pulls on first use |
| `gpt-sovits` | synthesis: the owner's published GPT-SoVITS image, pinned by digest | the same |
| `vixtts` | synthesis: the owner's viXTTS server, published as `legwork7623/vixtts` | the same |
| `tls` | nginx on 443 with the bundled config | `./nginx/generate-certs.sh` run once |

```bash
docker compose --profile whisper --profile gpt-sovits --profile tls up -d --build
```

Every speech engine is an image this stack pulls; none is built here (#212).
Every synthesis engine speaks one contract (`docs/speech-engine-contract.md`),
so the API is told `TTS_ENGINES=name=url,...` and nothing else about them; an
engine you already run elsewhere is one more entry, no profile needed.

**Giving the GPU back.** Each synthesis engine manages its own memory (#227):
it drops its weights after `TTS_IDLE_TIMEOUT`, on `POST /release`, and answers
503 when it cannot load them — at which point the API asks the least recently
used other engine to release and tries once more. Nothing reads the GPU from
the API and nothing touches a container, so the API needs no card and there is
no Docker proxy. The clients are told none of this: a request either returns
audio or the failure they already handle.

This is the fix for #98. All of it used to be unconditional, so a clean machine
could not start anything: the speech services built from absolute paths under
one developer's home directory, the API reserved `count: all` NVIDIA GPUs,
`central` was declared external and nothing creates it, and no service published
a port — a successful `up` produced a server no client could reach.
`tests/test_deployment_config.py` asserts each of those properties, and that
there are still only two Compose files, so none of it can quietly come back.

### Machine-specific extras

Two things cannot be profiles, because they change fields on an existing service
rather than adding one: a GPU reservation for the API's vision pipeline, and
attaching the API to a reverse-proxy network that some other stack owns. Those
go in `docker-compose.override.yml`, which Compose loads automatically and which
is gitignored precisely because it describes one machine:

```yaml
# backend/docker-compose.override.yml — not committed
services:
  api:
    # The vision pipeline (face recognition, gesture detection) on a GPU.
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    # An existing reverse proxy reaches the API over its own network, so the
    # published port is not needed.
    ports: !reset []
    networks:
      - default
      - central

networks:
  central:
    external: true
    name: central
```

Migrations auto-run on container startup via `docker-entrypoint.sh`, which now
waits a bounded number of attempts and prints the connection error rather than
retrying silently for ever. The image carries the application code — the Dockerfile copies `kurisuassistant/` and `scripts/` in — and the only thing the API container mounts from this directory is `data/`, which is runtime state. So a code change reaches the container through `docker compose up -d --build`, not by editing the checkout. To edit without rebuilding, use the dev overlay below: it mounts the source back over the image's copy.

## Releases and Deployment

There is no long-lived `dev` branch. Work happens on short-lived branches merged into `main` through pull requests, and a release is a tag on `main`: `vX.Y.Z`, with X.Y.Z equal to `__version__` in `version.py` — one tag for the backend and both clients (#256). The root `release.yml` builds the desktop installers and the Android APK from that tag and publishes them under one GitHub release; it refuses a tag whose number is not `__version__`. For the backend the tag *is* the release — there is no backend artifact, and a deployment is a checkout of the tag with `docker compose up -d --build` run from its `backend/`. To release: bump `__version__`, merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`. (`backend-vX.Y.Z` was the backend's own tag before #256; the last is `backend-v0.6.0`.)

Keep a deployment's checkout separate from the one you develop in. The checkout is a build context, an env file and a `data/` directory — the running code comes from the image, so editing the tree changes nothing until the next `--build`, and the image keeps running if the tree moves. What still makes a shared tree a bad idea is `data/` and the fixed project name: a second stack started from the same directory writes into the same user data. Move a deployment with checkout and rebuild in one step:

```bash
git fetch --tags && git checkout vX.Y.Z && docker compose up -d --build
```

**Moving an existing deployment onto the profile split needs two things written
down once.** The base file no longer hardcodes what one machine happened to
have, so a deployment that relied on either must say so in its environment file
or its override:

- `LLM_API_URL` now defaults to the host's Ollama. If yours runs as a container
  on a Docker network — the usual arrangement when Ollama is shared with other
  stacks — set `LLM_API_URL=http://<its container name>:11434` explicitly, or
  the API will look for an Ollama on the host and find none.
- The `central` network attachment and any GPU reservation are in
  `docker-compose.override.yml` now (block above). Without it the API is
  published on `API_PORT` instead of being reachable through the proxy.

Migrations run on container start, so the restart is also what applies them. `docker-compose.yml` pins `name: kurisuassistant`, so the project adopts the same containers and volumes (`postgres-container`, `kurisuassistant_postgres-data`) whichever directory it is started from — a checkout under a new path continues the same database instead of silently creating an empty one.

When a release bumps `WIRE_PROTOCOL`, let the tag's release run finish — it publishes both clients — and deploy the backend from that tag after, once the updaters have had their chance. The backend rejects a mismatched client with 426 and Android hard-gates on it, so deploying first locks every installed app out.

### A second instance

`docker-compose.dev.yml` starts a second, isolated API and database as its own Compose project — `kurisuassistant-dev`: `kurisu-api-dev`, `postgres-dev`, volume `kurisuassistant-dev_postgres-data`, its own `./data` — for trying `main` against a running backend without touching a deployment. It shares the GPU engines and Ollama with the deployment over the deployment's Compose network; the API uploads the voice reference with every TTS request, so nothing user-specific lives in those services.

```bash
# from the backend/ of the checkout you want to run — never the deployment's
cp /path/to/deployment/backend/.env .     # same credentials, separate database
docker compose -f docker-compose.dev.yml up -d --build
```

Unlike the plain stack, the overlay mounts `./kurisuassistant`, `./scripts`, `./tests` and `./pytest.ini` over the image's copy, so an edit takes effect on `docker compose -f docker-compose.dev.yml restart api` and `pytest` can run inside the container. That is also why it must be run from a checkout that is not also running the plain stack: the two would share `./data`, and the overlay would be editing the code of a tree a deployment builds from. It publishes `API_DEV_PORT` (15598) on loopback only — the plain stack already has 15597 — and it requires the two external networks in its header, which exist only where a production stack and a reverse proxy are already running. See the file's header for what is and is not shared.

## Tests

```bash
pytest -m "not integration"                          # what CI runs: unit + mock-Ollama + (with Postgres) db tests
POSTGRES_HOST=localhost POSTGRES_PORT=55432 pytest -m db   # migrations + system tests against a throwaway Postgres
pytest -m integration                                # a live Ollama / paid provider — by hand only, it costs money
```

Three markers, registered in `pytest.ini`:

- **unmarked** — pure unit tests, no services.
- **`db`** — needs Postgres: the migration tests and the *system tests* (`tests/test_system_chat.py`), which run the real app on a fresh database created for the session, create and activate their own account, log in as it, open `/ws/chat` and drive whole turns — streaming, thinking, the tool loop with its approval gate, compaction — with the model played by the mock Ollama. CI provides Postgres (`backend-test.yml`); locally they skip unless `POSTGRES_HOST`/`POSTGRES_PORT` point at one. A throwaway is `docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_USER=kurisu -e POSTGRES_PASSWORD=kurisu -e POSTGRES_DB=kurisu pgvector/pgvector:pg16`.
- **`integration`** — needs a real external service. Never runs in CI: a live model call costs money on a paid provider and needs a GPU otherwise. One of them is a measurement rather than a check: `tests/test_emotion_compliance.py` sends twenty prompts to the model at `LLM_API_URL` (`EMOTION_TEST_MODEL`, default `qwen3:8b`) with the Expression block and prints where the emotion tags landed — sentence starts, mid-sentence, every sentence, unknown labels — for a person deciding whether that model, or the prompt wording, is good enough (#243). Run it with `pytest tests/test_emotion_compliance.py -m integration -s`.

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
| `LLM_API_URL` | `http://localhost:11434` in-process, `http://host.docker.internal:11434` under Compose | Ollama server URL. The two defaults differ, and only the Compose one applies to a deployment. On Linux the host's Ollama must be started with `OLLAMA_HOST=0.0.0.0` or it refuses the container, which `GET /models` reports as a 502 naming this variable (#151) |
| `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `POE_API_KEY` | — | Cloud LLM providers; fallbacks when the user has no key stored |
| `TTS_ENGINES`, `ASR_URL` | (docker-compose) | The synthesis engines as `name=url` pairs (the names are the model ids the clients store), and the recognition engine. An engine not listed is not part of this deployment, and a request for it is refused with a sentence naming the profile to start |
| `TTS_IDLE_TIMEOUT` | `600` | Seconds without a request before a synthesis engine drops its own weights; `0` keeps them resident (#227) |
| `TTS_DEFAULT_MODEL` | first configured | Which synthesis engine answers a request that names none |
| `ASR_MODEL` | `base` | What the recognition container was started with; the API reads it only to name the model in the clients' picker |
| `GPTSOVITS_VOICE_DIR`, `GPTSOVITS_DEFAULT_LANGUAGE` | `/voice_storage`, `ja` | Where the GPT-SoVITS container sees `data/voice_storage/`, and the language it assumes |
| `JWT_SECRET_KEY` | generated | Overrides the secret persisted to `data/jwt_secret.key` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime |
| `CONVERSATION_IDLE_THRESHOLD_MINUTES` | `30` | Idle time before a conversation's memory is consolidated |
| `MCP_TLS_VERIFY` | `true` | Set to `false` to skip TLS verification on server-side MCP connections |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS`, `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `10`, `300` | Brute-force limit on `/login` and `/register`, per client address; `0` disables |
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS_PER_USER` | `20` | The same window counted per username — the bound that survives a shared address or a caller with many of them; `0` disables (#155) |
| `FORWARDED_ALLOW_IPS` | — | Addresses or CIDR subnets whose `X-Forwarded-For` is believed, comma-separated. Empty ignores the header and counts the socket peer. Behind a reverse proxy this must name it, or every caller shares one rate-limit bucket; `*` trusts everyone and the entrypoint warns (#155) |
| `DB_CONNECT_TIMEOUT_SECONDS`, `DB_STATEMENT_TIMEOUT_SECONDS` | `5`, `30` | libpq ceilings on the engine: TCP connect, and any one statement (`0` disables). Alembic builds its own engine and is not subject to them (#153) |
| `DB_OPERATION_TIMEOUT_SECONDS` | `60` | How long a request waits for the single database thread before answering 503 (#153) |
| `VISION_DEVICE` | — | `cpu` or `cuda` for gesture detection; empty picks `cuda` when torch sees a GPU, else `cpu` (#152) |
| `DRIVE_QUOTA_BYTES` | `16106127360` (15 GB) | How much Kurisu Drive one account may store. Registration is open by default, so an unmetered drive is a disk-exhaustion surface for the host; over it is `507` |
| `DRIVE_MAX_FILE_BYTES` | `2147483648` (2 GB) | Largest single drive file, enforced as the bytes arrive rather than after; over it is `413`. Behind `--profile tls`, nginx's `client_max_body_size` for `/drive/` applies too and the smaller of the two wins |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | `ollama`, `bge-m3` | The one embedding model behind `recall_semantic` (#6): `ollama` pulls it from `LLM_API_URL` on first use, `gemini` and `nvidia` use the server-wide keys. Empty `EMBEDDING_MODEL` switches semantic recall off; `recall_regex` keeps working. Changing the model re-embeds everything in the background (`retrieval.md`) |
| `RETRIEVAL_MAX_FILE_BYTES`, `RETRIEVAL_MAX_PASSAGES_PER_FILE` | `20971520` (20 MB), `2000` | Drive files over the byte cap are not indexed; a file stops chunking at the passage cap |

Read by Compose rather than by the server:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT`, `API_BIND` | `15597`, `0.0.0.0` | Where the API is published on the host. `API_BIND=127.0.0.1` keeps it off the network when a proxy fronts it |
| `API_DEV_PORT` | `15598` | The dev overlay's port, always on loopback |
| `HTTPS_PORT` | `443` | nginx's port, under `--profile tls` |
| `ASR_DEVICE`, `ASR_IDLE_TIMEOUT` | `cuda`, `300` | The recognition engine's, not the API's: it drops its model after this long idle and reloads on the next clip |
| `DB_WAIT_ATTEMPTS`, `DB_WAIT_INTERVAL` | `60`, `2` | How long the entrypoint waits for Postgres before failing loudly |

There is **no `DATA_DIR` variable** for the server: `core/paths.py` resolves `data/` from the package location and never reads the environment, so it is the `data/` beside the installed `kurisuassistant/` regardless of where a command is run. One migration used to read a `DATA_DIR` env var that nothing sets, and therefore looked for character assets under the literal `/app/data` outside the container; it now imports the same constant as everything else.

MCP tool-specific env vars (e.g. `SERPAPI_KEY`) are configured in each tool's own `.env` in the separate `mcp-servers` repo.

## Docker Volumes

Back up these volumes/directories:

- `postgres-data` — PostgreSQL database
- `./data` — images, avatars, voices, character assets, JWT secret
- `./data/drive` — Kurisu Drive, whatever users have stored. Its own subtree so it
  can be archived on its own schedule; it is the only part of `data/` that grows
  without bound. See [Operations](operations.md#back-up).

## Voice Files

Place voice reference files in `data/voice_storage/` (.wav/.mp3/.flac/.ogg).

## Default Account

A fresh database is seeded with nothing. Accounts come from registration, which is open by default, and each one is inactive until an operator sets `users.is_active` (#148) — see [Operations](operations.md#accounts). `init_db()` logs which accounts are waiting.
