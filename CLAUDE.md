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
- Notes & History — File-based per-agent notes (`kurisuassistant/tools/notes.py`) and DB-backed conversation history tools (`kurisuassistant/tools/history.py`)
- LLM Providers — Multi-provider support: Ollama (local) and Google Gemini (cloud). Per-agent `provider_type` field, per-user `gemini_api_key`. Provider factory in `kurisuassistant/models/llm/__init__.py`.

## Development Quick Reference

```bash
# Local
python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
python -m kurisuassistant.migrate   # Run migrations
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
