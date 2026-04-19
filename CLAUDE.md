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
- [Media Player](docs/media.md) — yt-dlp streaming, player registry, WebSocket events
- [Database](docs/database.md) — schema, session management, migrations
- [Development](docs/development.md) — local setup, Docker, env vars, volumes
- [API Reference](docs/API.md) — comprehensive endpoint documentation
- [GPT-SoVITS Setup](docs/gpt-sovits.md) — voice synthesis backend configuration
- [MCP Configuration](docs/mcp-config.md) — MCP server config format
- History — DB-backed conversation history tools (`kurisuassistant/tools/history.py`)
- LLM Providers — Multi-provider support: Ollama (local) and Google Gemini (cloud). Per-agent `provider_type` field, per-user `gemini_api_key`. Provider factory in `kurisuassistant/models/llm/__init__.py`.
- Authentication — JWT access (1h) + refresh (30d) tokens. Secret persisted to `data/jwt_secret.key`. Refresh endpoint: `POST /auth/refresh`. Client auto-refreshes on 401/4001 with exponential backoff WebSocket reconnection.
- Persona Merged Into Agent — Persona fields (voice_reference, avatar_uuid, character_config, preferred_name) now live directly on the `Agent` model (migration `83e667457a0b_merge_persona_into_agent`). The `personas` table and `routers/personas.py` CRUD remain as a rollback-safety artifact but are orphaned — nothing reads from them at runtime. Character assets stored under `data/character_assets/{agent_id}/`. `AgentConfig` carries `voice_reference`, `avatar_uuid`, `character_config`, `preferred_name`, and `agent_type` ('main' or 'sub') directly.
- Agent Orchestration — `_run_chat()` in `websocket/handlers.py` uses frame-scoped routing. Each `Frame` has an `active_agent_id`; on new frames, a lightweight routing LLM (`agents/selection.py`, default `gemma3:1b`) picks a main agent from the first user message. Main agents (`agent_type='main'`) get personality + the `handoff_to` tool (`tools/handoff.py`) for silent agent-to-agent transfer — up to `MAX_HANDOFFS` per turn. Sub-agents (`agent_type='sub'`) are exposed as callable tools via `SubAgentTool` (`tools/subagent.py`); they receive only the task string, not conversation history. The Administrator agent and `route_to` tool have been removed. `AgentRepository.list_enabled_for_user()` returns system + user's enabled agents. `AgentConfig` includes `description`, `enabled`, `is_system`, `agent_type`.
- Rolling Context Compaction — When context reaches 90% of model's context window, auto-compacts conversation into ~10% summary via inline LLM call. `Conversation.compacted_context` (rolling summary) + `compacted_up_to_id` (message watermark). `_load_context_messages()` loads compacted context + messages after watermark. Compacted context injected into agent system prompt via `AgentContext.compacted_context`. `ContextInfoEvent` sends compaction status + watermark data to client. Compaction prompt produces two sections: summary of older context + last 3-5 messages verbatim (preserves tone/language). Manual compaction via `/compact` slash command. Compacted messages protected from deletion.
- Message Queue — `_message_queue` on `ChatSessionHandler` queues incoming `chat_request` events while agent is busy instead of cancelling the running task. `_process_queue()` starts next queued message after DoneEvent or error. `_handle_cancel` clears the queue. API: `GET /conversations/{id}` returns `compacted_up_to_id`, `compacted_context`, `system_prompt_token_count` for frontend context window display.
- Tool Approval — Backend *always* emits `ToolApprovalRequestEvent` (with `execution_location` = "backend" or "frontend") for every tool call. The frontend is the policy authority: it consults the user's `tool_policies` (per-tool allow/deny) to auto-approve, auto-deny, or show a dialog. Policies persist on `User.tool_policies` (JSON) and are managed via `GET/PUT/PATCH /users/me/tool-policies`. Per-tool `requires_approval` / `risk_level` flags are gone.
- Context Breakdown — `ContextBreakdownEvent` emitted at the start of every LLM turn in `SimpleAgent.process` with per-component token counts (system prompt, memory, compacted context, skills, tools guidance, other_agents, message history, tool schemas) plus `loaded_tools` / `loaded_skills`. Mirrored by `GET /conversations/{id}/context-breakdown?agent_id=` for on-demand polling. `estimate_tokens()` in `agents/base.py` uses word_count × 1.3 as a heuristic.

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
