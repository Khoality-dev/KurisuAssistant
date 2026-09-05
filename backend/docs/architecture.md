# Architecture

How the backend is put together. Written against the tree, not against intent —
if this file and the code disagree, the code is right and this file is a bug.

## Services

The stack in `docker-compose.yml`:

- **api** (internal 15597) — the FastAPI app, `kurisuassistant/main.py`. Reached
  through an external `central` network rather than a bundled reverse proxy.
- **postgres** (internal 5432) — `pgvector/pgvector:pg16`. Not exposed to the host.
- **universal-voice** (internal 14213) — speech recognition and synthesis. The API
  proxies to it; it in turn fronts the two synthesis backends.
- **vixtts** (internal 19770) and **gpt-sovits** (internal 9880) — synthesis backends,
  reached through universal-voice rather than directly.

Ollama is not part of this stack. It is reached over the `central` network at a
URL each user configures.

`docker-compose.dev.yml` is an overlay that runs a second, isolated API and
database from a separate checkout. It inherits the api service's volumes from the
base file.

## Package layout

```
main.py                  FastAPI app: middleware, router mounting, lifespan
version.py               __version__ and WIRE_PROTOCOL (see "Versioning")

core/
  deps.py                get_authenticated_user; get_db is a legacy no-op
  security.py            bcrypt hashing, JWT issue/verify, access + refresh
  errors.py              internal_error(): log the exception, return a reference
  http.py                the shared httpx.AsyncClient for outbound calls
  paths.py               DATA_DIR, resolved from the package location, not from
                         the environment
  accounts.py            provision_user(): the assistant row + first persona an
                         account needs before it can chat

routers/                 one module per surface, all mounted in main.py
  auth, users, version   accounts, profile, protocol handshake
  conversations, messages
  assistant              the user's one assistant: model, tools, memory
  personas               how the assistant looks and sounds
  sub_agents             task-only workers
  portability            the shared export/import format for the two above
  models, tools, skills, mcp
  asr, tts               proxy to universal-voice
  images, character      serve stored media
  vision                 face identities and photos
  ws                     the WebSocket route and its handshake auth

websocket/
  events.py              the event dataclasses and parse_event()
  handlers.py            ChatSessionHandler: one session, the chat turn loop
  manager.py             ConnectionManager: sockets and handlers, keyed by user id

agents/
  base.py                BaseAgent, AgentContext, tool dispatch, and the three
                         configs: AssistantConfig (capability), PersonaConfig
                         (identity), SubAgentConfig (both, for a worker)
  main.py                MainAgent: the assistant speaking as a persona; streams
                         to the user and runs the tool loop
  sub.py                 SubAgent and the adapter exposing one as a tool
  selection.py           pick_persona(): override → default → first enabled, by id

tools/
  base.py, registry.py   BaseTool and the global registry
  history.py             conversation search and retrieval (built-in)
  skills.py              on-demand skill lookup (built-in)
  deferred.py            list/search/get_schema/call_tool meta-tools

models/                  inference providers; no DB access, no business logic
  llm/                   ollama, gemini, nvidia, poe behind a common base; nvidia and poe
                         are thin subclasses of the OpenAI-dialect openai_compat.py
  face_recognition/      InsightFace, 512-dimension embeddings
  gesture_detection/     pose and hand detection, rule-based classification

db/
  models.py              10 tables
  session.py             engine and sessionmaker
  service.py             DBService: the single thread all DB access goes through
  repositories/          one per table, over a generic BaseRepository
  alembic/               51 revisions, single head

vision/processor.py      per-frame face and gesture pipeline
workers/                 background threads: idle scan, memory consolidation
utils/                   prompt assembly, image storage, memory consolidation
```

## How a chat turn runs

1. The client sends `chat_request` over the socket.
2. `ChatSessionHandler._setup_conversation` resolves or creates the conversation
   and reads the user's preferences, including their tool policies.
3. A persona is resolved and persisted to `conversations.persona_id`: an explicit
   override (`chat_request.persona_id`, or the binding already stored) → the
   assistant's `default_persona_id` → the first enabled persona by id. Nothing
   scans for a trigger word and nothing is picked at random; the trigger word is a
   voice wake word on the assistant and selects nothing. The write happens on a
   rebind too, so a per-turn override survives to the next message.
4. Context is loaded: the conversation's `compacted_context` plus every message
   after `compacted_up_to_id`.
5. If the estimated size exceeds 90% of the context window and a summary model is
   configured, the conversation is compacted. Compaction creates a **new**
   conversation seeded with the summary, carries the persona binding over, and
   emits `conversation_switched`.
6. `MainAgent.process` runs the LLM loop — capability from the user's one
   `assistants` row, identity from the bound persona — at most 10 tool rounds, or
   25 with deferred tools. It yields a `stream_chunk` per content, thinking and
   tool chunk; tool chunks carry `tool_kind` and `duration_ms`.
7. The handler writes each message to the database as the role boundary crosses,
   not batched at the end, so a crash mid-turn keeps what was already said.
8. `done` closes the turn.

### Tool dispatch

`BaseAgent.execute_tool` resolves a call in this order:

1. the deferred meta-tools, when the agent uses them;
2. the native registry;
3. `extra_tools`, which is where sub-agent adapters live;
4. tools the client registered over the socket, executed on the client;
5. a server-side MCP server.

**Permission is decided by the server.** `users.tool_policies` is read once per
turn onto `AgentContext`. A stored `deny` returns immediately and never reaches
the client. A stored `allow` skips the prompt. Anything else asks the connected
client, whose answer can only narrow the server's decision, never widen it. With
no client attached, an unapproved call is refused rather than run.

## Sessions

`ConnectionManager` keys both sockets and handlers by user id. A handler
deliberately survives a reconnect, so a dropped connection can rejoin a running
turn, and it is evicted when the user's last connection closes.

Sessions are last-one-wins: a second connection displaces the earlier one with
close code 4003. Reconnecting clears the tools the previous client registered,
because they belonged to that client.

There is no application-level heartbeat. uvicorn pings at the protocol level,
configured in `docker-entrypoint.sh`.

## Authentication

JWT, HS256. Access tokens last 60 minutes, refresh tokens 30 days. The signing
key comes from `JWT_SECRET_KEY`, or is generated and persisted under `data/`.

HTTP routes depend on `get_authenticated_user`. The WebSocket authenticates
during the handshake, either with an `Authorization: Bearer` header or — for
browser clients, which cannot set headers on a socket — by offering
`kurisu.auth.bearer, <token>` as the subprotocol, which the server echoes on
accept.

Registration is closed unless `ALLOW_REGISTRATION` says otherwise. Login and
registration are rate limited per client address.

## Versioning

`version.py` holds `__version__` and `WIRE_PROTOCOL`. The integer is bumped on any
breaking change to what clients depend on: renamed or removed fields, changed
types, changed event names, a restructured auth handshake. Adding an optional
field does not bump it.

Clients ship their own constant and check it against `GET /version` at startup.
REST requests carry `X-Wire-Protocol` and a mismatch is rejected with 426. The
WebSocket handshake enforces the same number: a client declares it with the same
header, or — in a browser, which cannot set one — as a `kurisu.wire.<n>` entry in
the subprotocol list alongside its token. A mismatch is closed with 4426 before
authentication. Saying nothing is still allowed on both transports, so curl and
internal tooling keep working.

Releases are tags on `main`, not branches: `backend-vX.Y.Z`, with X.Y.Z equal to
`__version__`. The backend has no publish workflow — a deployment checks the tag out
and rebuilds (see `development.md`, "Releases and Deployment"). The clients are released by
tag too (`desktop-v*`, `android-v*`), and those tags *do* trigger publish workflows.
When a release bumps `WIRE_PROTOCOL`, the clients must be published before the
backend is deployed.

## Data

Ten tables: `users`, `assistants`, `personas`, `sub_agents`, `conversations`,
`messages`, `skills`, `mcp_servers`, `face_identities`, `face_photos`. See
`database.md`.

The old merged `agents` table was split in migration `0dacee9f63b8`: one
`assistants` row per user holds capability (model, tools, memory, wake word,
default persona), `personas` holds presentation, and `sub_agents` holds task-only
workers. `agents` was **renamed** to `personas` with its ids intact, because
`data/character_assets/{id}/` and the URLs inside `character_config` are keyed on
them.

Media does not live in the database. Images, voice reference clips and character
assets are files under `data/`, referenced by identifier from a row.

**All database access goes through one thread.** `DBService` owns a queue and a
single worker; `await db.execute(op)` suspends the caller, `execute_sync(op)`
blocks and belongs only in worker threads. This is a deliberate serialization
point and also the throughput ceiling: the engine's connection pool never has
more than one connection in use.

## Conventions

**Nothing blocks the event loop.** Outbound HTTP uses the shared async client in
`core/http.py`. Synchronous SDK calls go through `asyncio.to_thread`. Database
work on the loop is awaited, never `execute_sync`. `tests/test_event_loop_hygiene.py`
enforces this, because the symptom — everything slow, for everyone — does not look
like a bug in the code that caused it.

**Errors do not echo exceptions.** An unexpected exception is logged with its
traceback and a short reference; the caller gets a generic message and that
reference. Raw exception text carries failing SQL, internal URLs and server paths.

```python
except HTTPException:
    raise
except Exception as e:
    raise internal_error(e, "listing conversations")
```

**Repositories take a session, and callers use ids.** A repository never opens its
own session, and business logic keys on `user.id` rather than the username.

**Providers are pluggable.** Each of LLM, face recognition and gesture detection
has an abstract base, concrete providers, and a factory. Providers know nothing
about users, conversations or the database.
