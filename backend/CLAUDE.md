# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (faster-whisper), TTS (GPT-SoVITS/viXTTS), and LLM (Ollama). Microservices architecture with Docker Compose.

This is the `backend/` package of the KurisuAssistant monorepo (see the root `CLAUDE.md`). The desktop and Android clients live in `../clients/`. Run every command below from `backend/`: the server resolves `data/` relative to the working directory.

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
- [API Reference](docs/API.md) — comprehensive endpoint documentation
- [GPT-SoVITS Setup](docs/gpt-sovits.md) — voice synthesis backend configuration
- [MCP Configuration](docs/mcp-config.md) — how MCP servers are configured
- History — DB-backed conversation history tools (`kurisuassistant/tools/history.py`)
- LLM Providers — Multi-provider support: Ollama (local), Google Gemini and NVIDIA NIM (cloud). `provider_type` lives on the user's `assistants` row and on each `sub_agents` row; per-user `gemini_api_key` / `nvidia_api_key` are write-only. Provider factory in `kurisuassistant/models/llm/__init__.py`.
- Authentication — JWT access (1h) + refresh (30d) tokens. Secret persisted to `data/jwt_secret.key`. Refresh endpoint: `POST /auth/refresh`. Client auto-refreshes on 401/4001 with exponential backoff WebSocket reconnection.
- Assistant / Persona / Sub-Agent Split — The merged `Agent` model is **gone**; migration `0dacee9f63b8_split_persona_from_assistant` reversed the earlier merge. Three tables now:
  - **`assistants`** — exactly one row per user, capability only: `model_name`, `provider_type`, `available_tools` (null = every tool), `think`, `use_deferred_tools`, `memory`, `memory_enabled`, plus `trigger_word` and `default_persona_id`. Created at registration (`core/accounts.py::provision_user`), so `/assistant` has GET and PATCH but no POST and no DELETE.
  - **`personas`** — many per user, presentation only: `name`, `description`, `system_prompt`, `preferred_name`, `voice_reference`, `avatar_uuid`, `character_config`, `enabled`. A persona has **no model, no tools, no memory and no trigger word**.
  - **`sub_agents`** — task-only workers with their own `model_name`/`provider_type`/`available_tools`/`think`/`use_deferred_tools`, no identity and **no memory** (the consolidation pipeline only ever wrote main-agent memory, so the column could never have been filled).
  - The migration renames `agents` → `personas` **preserving ids**, because `data/character_assets/{id}/` and the URLs inside `character_config` are keyed on them. There is deliberately no disk work in it. `conversations.main_agent_id` → `conversations.persona_id`, `messages.agent_id` → `messages.persona_id`. The `/agents` REST surface is removed, not aliased.
- Agents & Orchestration — Two concrete agent classes in `agents/`:
  - **`MainAgent`** (`agents/main.py`) — constructed as `MainAgent(assistant, tool_registry, identity=persona)`. `capabilities` is an `AssistantConfig` (what it can do); `identity` is a `PersonaConfig` (who is speaking). Streams `StreamChunkEvent` to the user and owns the conversation.
  - **`SubAgent`** (`agents/sub.py`) — task-only, no identity, no streaming to frontend. Runs an internal LLM + tool-loop and returns a single string to its caller via `execute(task, context)`. Exposed to a MainAgent's LLM through the `SubAgentTool` adapter in the same file; `capabilities` and `identity` are the same `SubAgentConfig` object.
  - Both extend `BaseAgent` (`agents/base.py`) for shared tool-approval + MCP plumbing.
- Conversation = one persona — Each `Conversation` has a `persona_id` FK, null until the first message binds it, then persisted. `agents/selection.py::pick_persona` resolves it deterministically: explicit override (`chat_request.persona_id`, or the stored binding) → `assistants.default_persona_id` → the user's first enabled persona by id → `ValueError`. **There is no trigger-word scan and no random pick.** The trigger word is an assistant-level *voice wake word*: saying it wakes the assistant and the bound persona answers; it selects nothing. A persona override is written back to `conversations.persona_id` on every rebind (also settable out of band with `PATCH /conversations/{id}`), so it survives a reconnect.
- Frames removed — The old `frames` table + `message.frame_id` + `Frame.summary` are gone (migration `0caebafdf4cc`). Messages are stored directly on the conversation (`message.conversation_id` indexed FK). `Conversation.compacted_context` is the sole summary source.
- Rolling Context Compaction — When context reaches 90% of the model's context window, the conversation is compacted into a ~10% summary via an inline LLM call. In practice compaction **forks**: it creates a *new* conversation seeded with the summary as `compacted_context`, carries the persona binding over, and emits `conversation_switched`. `compacted_up_to_id` is honoured by `_load_context_messages` but never advanced by this path. Manual trigger: the `compact_context` WebSocket event.
- Memory Consolidation — Memory is **one document per user**, on that user's single `assistants` row, shared by every persona. Runs at **conversation idle**: `_scan_idle_conversations()` (`workers/service.py`, every 60s) finds conversations whose `updated_at` is past `CONVERSATION_IDLE_THRESHOLD_MINUTES` whose owner's assistant has `memory_enabled = true` and which have at least one message, and enqueues **one** `ConsolidateMemoryTask` per conversation (no agent id — the target is derived from `user_id`). An internal dedupe set prevents re-queueing while the conversation stays idle. `utils/memory_consolidation.py` feeds the bound persona's `system_prompt` in as "session instructions" but the document itself must stay persona-neutral. **The read-modify-write on `assistants.memory` is only safe because the single `db-worker` thread serializes it** — do not parallelize it without making the write atomic. Empty LLM output is **logged**, not silently dropped.
- Message Queue — `_message_queue` on `ChatSessionHandler` queues incoming `chat_request` events while the agent is busy instead of cancelling the running task, capped at `MAX_QUEUED_MESSAGES` (20); over the cap the client gets an `error` with code `QUEUE_FULL`. `_process_queue()` merges the queue into one follow-up turn after `done` or an error. `_handle_cancel` clears the queue.
- Tool Approval — **The server is the policy authority.** `users.tool_policies` is read once per turn onto `AgentContext`, and `BaseAgent.execute_tool` applies it before dispatch: a stored `deny` returns immediately and never reaches the client; a stored `allow` skips the prompt; anything else emits `ToolApprovalRequestEvent` (with `execution_location` = "backend" or "frontend") and the client's answer can only narrow the server's decision, never widen it. With no client session attached, an unapproved call is refused rather than run. Policies are managed via `GET/PUT/PATCH /users/me/tool-policies`. Per-tool `requires_approval` / `risk_level` flags do not exist.
- Wire Protocol — `version.py` holds `__version__` and `WIRE_PROTOCOL`, currently **4**, with a full changelog. HTTP requests carrying a mismatched `X-Wire-Protocol` get 426 (`/health` and `/version` exempt). The `/ws/chat` handshake enforces the same number — header, or a `kurisu.wire.<n>` subprotocol entry for browsers — and closes with **4426** *before* authenticating. Absence is allowed on both transports.

## Development Quick Reference

```bash
# Local
python -m venv venv && source venv/bin/activate && pip install -r requirements.txt
python -m scripts.migrate            # Run migrations
uvicorn kurisuassistant.main:app --host 0.0.0.0 --port 15597 --reload --reload-dir kurisuassistant
./run_dev.bat                       # Same, on Windows

# Docker
docker compose up -d       # Start all
docker compose logs -f api # View logs

# Dev deployment: separate worktree (../KurisuAssistant-dev, detached at the commit
# under test — there is no dev branch) running docker-compose.dev.yml: own API,
# Postgres and data/, shared GPU services. Production deploys from a backend-vX.Y.Z
# tag. See docs/development.md "Dev Deployment". Never run the dev overlay from this
# tree, and never `git checkout` under a running container without restarting it in
# the same step — the API bind-mounts ./kurisuassistant, so the code changes live.

# Migrations (Alembic, auto-run on container startup via docker-entrypoint.sh)
cd kurisuassistant/db && alembic revision --autogenerate -m "description"
```

## Alembic Migrations

- **Always** use `cd kurisuassistant/db && alembic revision --autogenerate -m "short_snake_case"` — never hand-write migration files.
- Naming: `-m` becomes the filename slug. Use `add_foo_to_bar`, `remove_baz_column`, `create_widgets_table`.
- After generating, verify single head: `cd kurisuassistant/db && alembic heads`. If multiple heads, merge with `alembic merge heads -m "merge_heads"`.
- Review the generated `upgrade()`/`downgrade()` — autogenerate misses renames and data migrations.
- Never use plain-text revision IDs — always let Alembic generate the hash.
