# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (faster-whisper), TTS (GPT-SoVITS/viXTTS), and LLM (Ollama). Microservices architecture with Docker Compose.

This is the `backend/` package of the KurisuAssistant monorepo (see the root `CLAUDE.md`). The desktop and Android clients live in `../clients/`. Run every command below from `backend/` — that is where `docker-compose.yml` lives. (`data/` is resolved from the package location, not the working directory: `core/paths.py`.)

## Documentation Index

- [Architecture](docs/architecture.md) — services, directory structure, design principles, key patterns
- [Agents](docs/agents.md) — the assistant, its personas, sub-agents, tool access, memory
- [WebSocket Protocol](docs/websocket.md) — handshake, event types, reconnection
- [TTS](docs/tts.md) — providers, voice discovery, text splitting, viXTTS notes
- [ASR](docs/asr.md) — faster-whisper, frontend VAD, interactive modes, optimizations
- [Tools & Skills](docs/tools.md) — built-in tools, MCP tools (server + client), skills system
- [Skills Format](docs/skills.md) — skill format, prompt injection, API
- [Vision Pipeline](docs/vision.md) — face recognition, gesture detection, character animation
- [Database](docs/database.md) — schema, session management, migrations
- [Development](docs/development.md) — local setup, Docker, env vars, volumes
- [Operations](docs/operations.md) — backup and restore, updating, removal, and what persists. Everything after a server is running; getting one running is the deployment tutorial in the root `README.md`.
- [API Reference](docs/API.md) — comprehensive endpoint documentation
- [GPT-SoVITS Setup](docs/gpt-sovits.md) — voice synthesis backend configuration
- [MCP Configuration](docs/mcp-config.md) — how MCP servers are configured
- History — DB-backed conversation history tools (`kurisuassistant/tools/history.py`)
- LLM Providers — Multi-provider support: Ollama (local), Google Gemini, NVIDIA NIM and Poe (cloud). `provider_type` lives on the user's `assistants` row and on each `sub_agents` row; per-user `gemini_api_key` / `nvidia_api_key` / `poe_api_key` are write-only. NVIDIA and Poe are thin subclasses of `models/llm/openai_compat.py` (the OpenAI chat-completions dialect: message conversion, SSE parsing, readable error messages). Poe's model catalogue is public, so `PoeProvider.validate_key` probes with a one-token request for a nonexistent model instead of listing models; every provider exposes `validate_key()`, which `POST /models/validate-key` calls. Provider factory in `kurisuassistant/models/llm/__init__.py`.
- Authentication — JWT access (1h) + refresh (30d) tokens. Secret persisted to `data/jwt_secret.key`. Refresh endpoint: `POST /auth/refresh`. Client auto-refreshes on 401/4001 with exponential backoff WebSocket reconnection.
- Assistant / Persona / Sub-Agent Split — The merged `Agent` model is **gone**; migration `0dacee9f63b8_split_persona_from_assistant` reversed the earlier merge. Three tables now:
  - **`assistants`** — exactly one row per user, capability only: `model_name`, `provider_type`, `available_tools` (null = every tool), `think`, `use_deferred_tools`, `memory`, `memory_enabled`, plus `trigger_word` and `default_persona_id`. Created at registration (`core/accounts.py::provision_user`), so `/assistant` has GET and PATCH but no POST and no DELETE. `model_name` is the one field provisioning **cannot** fill — which model to use depends on the operator's providers and there is nothing to ask at registration — so every new account starts with it NULL. A `chat_request` with no model on the row and none in the request is refused with an `error` coded `NO_MODEL_SELECTED`, checked inside `_setup_conversation` above `create_conversation` so nothing is created; both clients turn that code into a way onto the Assistant screen (#149).
  - **`personas`** — many per user, presentation only: `name`, `description`, `system_prompt`, `preferred_name`, `voice_reference`, `avatar_uuid`, `character_config`, `enabled`. A persona has **no model, no tools, no memory and no trigger word**.
  - **`sub_agents`** — task-only workers with their own `model_name`/`provider_type`/`available_tools`/`think`/`use_deferred_tools`, no identity and **no memory** (the consolidation pipeline only ever wrote main-agent memory, so the column could never have been filled).
  - The migration renames `agents` → `personas` **preserving ids**, because `data/character_assets/{id}/` and the URLs inside `character_config` are keyed on them. There is deliberately no disk work in it. `conversations.main_agent_id` → `conversations.persona_id`, `messages.agent_id` → `messages.persona_id`. The `/agents` REST surface is removed, not aliased.
- Agents & Orchestration — Two concrete agent classes in `agents/`:
  - **`MainAgent`** (`agents/main.py`) — constructed as `MainAgent(assistant, tool_registry, identity=persona)`. `capabilities` is an `AssistantConfig` (what it can do); `identity` is a `PersonaConfig` (who is speaking). Streams `StreamChunkEvent` to the user and owns the conversation.
  - **`SubAgent`** (`agents/sub.py`) — task-only, no identity, no streaming to frontend. Runs an internal LLM + tool-loop and returns a single string to its caller via `execute(task, context)`. Exposed to a MainAgent's LLM through the `SubAgentTool` adapter in the same file; `capabilities` and `identity` are the same `SubAgentConfig` object.
  - Both extend `BaseAgent` (`agents/base.py`) for shared tool-approval + MCP plumbing.
- Conversation = one persona — Each `Conversation` has a `persona_id` FK, null until the first message binds it, then persisted. `agents/selection.py::pick_persona` resolves it deterministically: explicit override (`chat_request.persona_id`, or the stored binding) → `assistants.default_persona_id` → the user's first enabled persona by id → `ValueError`. **There is no trigger-word scan and no random pick.** The trigger word is an assistant-level *voice wake word*: saying it wakes the assistant and the bound persona answers; it selects nothing. A persona override is written back to `conversations.persona_id` on every rebind (also settable out of band with `PATCH /conversations/{id}`), so it survives a reconnect.
- Frames removed — The old `frames` table + `message.frame_id` + `Frame.summary` are gone (migration `0caebafdf4cc`). Messages are stored directly on the conversation (`message.conversation_id` indexed FK). `Conversation.compacted_context` is the sole summary source.
- Rolling Context Compaction — At 90% of the model's context window the conversation is compacted **in place**: an inline LLM call produces a ~10% summary, `_compact_in_place` writes it to `conversations.compacted_context` and moves `compacted_up_to_id` to the last message it covers, and `_load_context_messages` reads the summary plus everything after that id. The conversation keeps its id, title, persona binding and stored messages. `context_info` is sent with `compacting: true` and again with `compacting: false` on **every** exit path — the empty-summary path used to return leaving the client's spinner running. Compaction used to fork into a new conversation and emit `conversation_switched`; that event no longer exists (#99). Manual trigger: the `compact_context` WebSocket event.
- Context accounting — `utils/tokens.py` estimates what a message list costs: characters over words, plus per-message framing, thinking blocks, tool-call arguments, and a flat `TOKENS_PER_IMAGE` per image (never the length of a UUID or of base64). It drives both the compaction trigger and the counter on `stream_chunk`, so the two cannot disagree. It is still an estimate biased high — no provider here reports its own prompt token count back to the handler (#99).
- Memory Consolidation — Memory is **one document per user**, on that user's single `assistants` row, shared by every persona. Runs at **conversation idle**: `_scan_idle_conversations()` (`workers/service.py`, every 60s) finds conversations whose `updated_at` is past `CONVERSATION_IDLE_THRESHOLD_MINUTES` whose owner's assistant has `memory_enabled = true` and which have at least one message, and which have not been consolidated since they last changed (`conversations.consolidated_at` null or older than `updated_at`), oldest first, at most `SCAN_LIMIT` (50) per scan over an index on `updated_at`, and enqueues **one** `ConsolidateMemoryTask` per conversation (no agent id — the target is derived from `user_id`). The outcome is written back to the row (#96): success stamps `consolidated_at`; a failure — `consolidate_assistant_memory` now **raises** instead of swallowing — bumps `consolidation_attempts` and sets `consolidation_next_retry_at` (5 min doubling, 6 h cap), and after `MAX_ATTEMPTS` (5) the row is stamped and left alone until it changes. The in-memory `_queued` set only covers the in-flight window and is released in a `finally`. `utils/memory_consolidation.py` feeds the bound persona's `system_prompt` in as "session instructions" but the document itself must stay persona-neutral. **The read-modify-write on `assistants.memory` is only safe because the single `db-worker` thread serializes it** — do not parallelize it without making the write atomic. Empty LLM output is **logged**, not silently dropped.
- Message Queue — `_message_queue` on `ChatSessionHandler` queues incoming `chat_request` events while the agent is busy instead of cancelling the running task, capped at `MAX_QUEUED_MESSAGES` (20); over the cap the client gets an `error` with code `QUEUE_FULL`. `_process_queue()` merges the queue into one follow-up turn after `done` or an error — except `NO_MODEL_SELECTED`, which **clears** it instead: every queued message would fail the same way, and replaying them at the end of the next turn would answer them after the user had picked a model, long after they were sent (#149). `_handle_cancel` clears the queue too.
- Tool Approval — **The server is the policy authority.** `users.tool_policies` is read once per turn onto `AgentContext`, and `BaseAgent.execute_tool` applies it before dispatch: a stored `deny` returns immediately and never reaches the client; a stored `allow` skips the prompt; anything else emits `ToolApprovalRequestEvent` (with `execution_location` = "backend" or "frontend") and the client's answer can only narrow the server's decision, never widen it. With no client session attached, an unapproved call is refused rather than run. Policies are managed via `GET/PUT/PATCH /users/me/tool-policies`. Per-tool `requires_approval` / `risk_level` flags do not exist.
- Failures are loud — Three things used to fail silently and now do not. The single `db-service` thread logs every failed operation with a traceback, waits at most `DB_OPERATION_TIMEOUT_SECONDS` before raising `DBUnavailableError` (a 503 via `core/errors.py`), and the engine has connect and statement timeouts (#153, `docs/database.md`). Provider `list_models()` **raises** on an unreachable host — never an empty list, never a fabricated catalogue — and `GET /models` reports each unreachable provider in `unavailable`, or 502 when none answered; `GET /tts/models` is 502 when universal-voice is down (#151). Gesture detection resolves its torch device (`VISION_DEVICE`, else `cuda` if available, else `cpu`) instead of assuming a GPU (#152, `docs/vision.md`).
- Wire Protocol — `version.py` holds `__version__` and `WIRE_PROTOCOL`, currently **4**, with a full changelog. HTTP requests carrying a mismatched `X-Wire-Protocol` get 426 (`/health` and `/version` exempt). The `/ws/chat` handshake enforces the same number — header, or a `kurisu.wire.<n>` subprotocol entry for browsers — and closes with **4426** *before* authenticating. Absence is allowed on both transports.

## Development Quick Reference

```bash
# Local
python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
python -m scripts.migrate            # Run migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant

# Docker
docker compose up -d       # Start all
docker compose logs -f api # View logs

# Deployments run a release tag (backend-vX.Y.Z) from their own checkout, never from
# the tree you develop in: the image carries the code (the Dockerfile COPYs it) so a
# checkout no longer swaps the live code, but the two would share ./data and the fixed
# project name. Move one with `git fetch --tags && git checkout <tag> &&
# docker compose up -d --build` in ONE step — the rebuild is what ships the code. For
# a second, isolated instance to try
# main against: `docker compose -f docker-compose.dev.yml up -d --build` (own
# project, database and data/). See docs/development.md "Releases and Deployment".

# Migrations (Alembic, auto-run on container startup via docker-entrypoint.sh)
cd kurisuassistant/db && alembic revision --autogenerate -m "description"

# Tests: `pytest -m "not integration"` is what CI runs. Anything that talks to a
# model talks to tests/mock_ollama (in-process; script with Reply(...)); the
# db-marked migration + system tests need Postgres (POSTGRES_HOST/PORT, else
# skipped; CI provides one). `integration` = a live model — by hand only, it
# costs money. See docs/development.md "Tests".
```

## Alembic Migrations

- **Always** use `cd kurisuassistant/db && alembic revision --autogenerate -m "short_snake_case"` — never hand-write migration files.
- Naming: `-m` becomes the filename slug. Use `add_foo_to_bar`, `remove_baz_column`, `create_widgets_table`.
- After generating, verify single head: `cd kurisuassistant/db && alembic heads`. If multiple heads, merge with `alembic merge heads -m "merge_heads"`.
- Review the generated `upgrade()`/`downgrade()` — autogenerate misses renames and data migrations.
- Never use plain-text revision IDs — always let Alembic generate the hash.
