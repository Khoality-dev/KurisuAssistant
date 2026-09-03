# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (faster-whisper), TTS (GPT-SoVITS/viXTTS), and LLM (Ollama). Microservices architecture with Docker Compose.

## Documentation Index

- [Architecture](docs/architecture.md) — services, directory structure, design principles, key patterns
- [Agents & Orchestration](docs/agents.md) — single/group modes, agent memory, tool access control
- [WebSocket Protocol](docs/websocket.md) — connection, reconnection, heartbeat, event types
- [TTS](docs/tts.md) — providers, voice discovery, text splitting, viXTTS notes
- [ASR](docs/asr.md) — faster-whisper, frontend VAD, interactive modes, optimizations
- [Tools & Skills](docs/tools.md) — built-in/opt-in tools, MCP tools (server + client), skills system
- [Skills Format](docs/skills.md) — skill format, export/import, writing guide, API
- [Vision Pipeline](docs/vision.md) — face recognition, gesture detection, character animation
- [Database](docs/database.md) — schema, session management, migrations
- [Development](docs/development.md) — local setup, Docker, env vars, volumes
- [API Reference](docs/API.md) — comprehensive endpoint documentation
- [GPT-SoVITS Setup](docs/gpt-sovits.md) — voice synthesis backend configuration
- [MCP Configuration](docs/mcp-config.md) — MCP server config format
- History — DB-backed conversation history tools (`kurisuassistant/tools/history.py`)
- LLM Providers — Multi-provider support: Ollama (local) and Google Gemini (cloud). Per-agent `provider_type` field, per-user `gemini_api_key`. Provider factory in `kurisuassistant/models/llm/__init__.py`.
- Authentication — JWT access (1h) + refresh (30d) tokens. Secret persisted to `data/jwt_secret.key`. Refresh endpoint: `POST /auth/refresh`. Client auto-refreshes on 401/4001 with exponential backoff WebSocket reconnection.
- Persona Merged Into Agent — Persona fields (voice_reference, avatar_uuid, character_config, preferred_name) live directly on the `Agent` model. The `personas` table, `Persona` model, `PersonaRepository`, and `/personas` router were fully removed (migrations `83e667457a0b_merge_persona_into_agent` copies persona fields into agent; `facf3c9e62a8_drop_personas_table_and_rename_assets` renames `data/character_assets/{persona_id}/` → `{agent_id}/` on disk, rewrites URLs in `agent.character_config`, and drops the table). Character assets live under `data/character_assets/{agent_id}/`. `AgentConfig` carries `voice_reference`, `avatar_uuid`, `character_config`, `preferred_name`, and `agent_type` ('main' or 'sub') directly.
- Agents & Orchestration — Two concrete agent classes in `agents/`:
  - **`MainAgent`** (`agents/main.py`) — has identity (voice, avatar, character_config, preferred_name, trigger_word). Streams `StreamChunkEvent` + `ContextBreakdownEvent` to the user. Owns the conversation.
  - **`SubAgent`** (`agents/sub.py`) — task-only, no identity, no streaming to frontend. Runs an internal LLM + tool-loop and returns a single string to its caller via `execute(task, context)`. Exposed to a MainAgent's LLM through the `SubAgentTool` adapter in the same file.
  - Both extend `BaseAgent` (`agents/base.py`) for shared tool-approval + MCP plumbing.
- Conversation = one main agent — Each `Conversation` has a `main_agent_id` FK, picked **once** on the first message and persisted. Selection (`agents/selection.py::pick_main_agent`) scans the message for any enabled main agent's `trigger_word` (case-insensitive, word-boundary) and falls back to random. No per-message re-routing, no handoff. Sub-agents are opt-in per user and callable by any main agent via injected `SubAgentTool` adapters.
- Frames removed — The old `frames` table + `message.frame_id` + `Frame.summary` are gone (migration `0caebafdf4cc`). Messages are stored directly on the conversation (`message.conversation_id` indexed FK). `Conversation.compacted_context` is the sole summary source.
- Rolling Context Compaction — When context reaches 90% of model's context window, auto-compacts conversation into ~10% summary via inline LLM call. `Conversation.compacted_context` (rolling summary) + `compacted_up_to_id` (message watermark). Compacted context injected into agent system prompt via `AgentContext.compacted_context`. Manual trigger via `/compact` slash command.
- Memory Consolidation — Runs at **conversation idle**. Background `_scan_idle_conversations()` worker (`kurisuassistant/workers/service.py`, every 60s) finds conversations whose `updated_at` is past `CONVERSATION_IDLE_THRESHOLD_MINUTES`, collects the set of agents that actually participated (`SELECT DISTINCT agent_id FROM messages WHERE conversation_id=X`, filtered by `memory_enabled=true`), and enqueues one `ConsolidateMemoryTask` per pair. An internal dedupe set prevents re-queueing while the conversation stays idle. Empty LLM output is **logged**, not silently dropped.
- Message Queue — `_message_queue` on `ChatSessionHandler` queues incoming `chat_request` events while agent is busy instead of cancelling the running task. `_process_queue()` starts next queued message after DoneEvent or error. `_handle_cancel` clears the queue.
- Tool Approval — Backend *always* emits `ToolApprovalRequestEvent` (with `execution_location` = "backend" or "frontend") for every tool call. The frontend is the policy authority: it consults the user's `tool_policies` (per-tool allow/deny) to auto-approve, auto-deny, or show a dialog. Policies persist on `User.tool_policies` (JSON) and are managed via `GET/PUT/PATCH /users/me/tool-policies`. Per-tool `requires_approval` / `risk_level` flags are gone.
- Context Breakdown — `ContextBreakdownEvent` emitted at the start of every LLM turn in `ChatAgent.process` with per-component token counts (system prompt, memory, compacted context, skills, tools guidance, other_agents, message history, tool schemas) plus `loaded_tools` / `loaded_skills`. Mirrored by `GET /conversations/{id}/context-breakdown?agent_id=` for on-demand polling. `estimate_tokens()` in `agents/base.py` uses word_count × 1.3 as a heuristic.

## Development Quick Reference

```bash
# Local
python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
python -m scripts.migrate            # Run migrations
./run_dev.bat                       # Start server (Windows)

# Docker
docker-compose up -d       # Start all
docker-compose logs -f api # View logs

# Migrations (Alembic, auto-run on container startup via docker-entrypoint.sh)
cd kurisuassistant/db && alembic revision --autogenerate -m "description"
```

## Alembic Migrations

- **Always** use `cd kurisuassistant/db && alembic revision --autogenerate -m "short_snake_case"` — never hand-write migration files.
- Naming: `-m` becomes the filename slug. Use `add_foo_to_bar`, `remove_baz_column`, `create_widgets_table`.
- After generating, verify single head: `cd kurisuassistant/db && alembic heads`. If multiple heads, merge with `alembic merge heads -m "merge_heads"`.
- Review the generated `upgrade()`/`downgrade()` — autogenerate misses renames and data migrations.
- Never use plain-text revision IDs — always let Alembic generate the hash.
