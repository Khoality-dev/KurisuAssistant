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
- Persona/Agent Split — Agent split into Persona (identity/voice/avatar/animation) + Agent (role/capability). Persona CRUD router at `kurisuassistant/routers/personas.py`, repository at `kurisuassistant/db/repositories/persona.py`. Personas own voice_reference, avatar_uuid, character_config, preferred_name, trigger_word. Export/import as ZIP with persona.json + assets. Runtime: `AgentConfig` carries resolved persona fields (persona_name, persona_system_prompt, voice_reference, avatar_uuid, preferred_name, trigger_word). System prompt merges agent instructions then persona personality. Character assets stored under `data/character_assets/{persona_id}/`.
- Agent Orchestration — Unified `_run_chat()` in `handlers.py` replaces old `_run_single_agent`/`_run_orchestration`. Administrator agent (is_system=True) uses `route_to` tool to delegate to sub-agents. Sub-agents receive only the route message; Administrator sees full history. `RouteToTool` in `kurisuassistant/tools/routing.py` dynamically lists available agent names/descriptions. Agent model has `enabled`, `is_system`, `description` fields. `AgentRepository.list_enabled_for_user()` loads system + user's enabled agents. `AgentConfig` includes `description`, `enabled`, `is_system` fields.

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
