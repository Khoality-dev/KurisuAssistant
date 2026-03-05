# CLAUDE.md

## Project Overview

KurisuAssistant is a voice-based AI assistant platform combining STT (faster-whisper), TTS (GPT-SoVITS/INDEX-TTS), and LLM (Ollama). Microservices architecture with Docker Compose.

## Documentation Index

- [Architecture](docs/architecture.md) — services, directory structure, design principles, key patterns
- [Agents & Orchestration](docs/agents.md) — single/group modes, agent memory, tool access control
- [WebSocket Protocol](docs/websocket.md) — connection, reconnection, heartbeat, event types
- [TTS](docs/tts.md) — providers, voice discovery, text splitting, INDEX-TTS emotion
- [ASR](docs/asr.md) — faster-whisper, frontend VAD, interactive modes, optimizations
- [Tools & Skills](docs/tools.md) — built-in/opt-in tools, MCP tools (server + client), skills system
- [Vision Pipeline](docs/vision.md) — face recognition, gesture detection, character animation
- [Media Player](docs/media.md) — yt-dlp streaming, player registry, WebSocket events
- [Database](docs/database.md) — schema, session management, migrations
- [Development](docs/development.md) — local setup, Docker, env vars, volumes
- [API Reference](docs/API.md) — comprehensive endpoint documentation
- [GPT-SoVITS Setup](docs/gpt-sovits.md) — voice synthesis backend configuration
- [MCP Configuration](docs/mcp-config.md) — MCP server config format

## Development Quick Reference

```bash
# Local
python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt
python migrate.py          # Run migrations
./run_dev.bat              # Start server (Windows)

# Docker
docker-compose up -d       # Start all
docker-compose logs -f api # View logs

# Migrations (Alembic, auto-run on container startup via docker-entrypoint.sh)
cd db && alembic revision --autogenerate -m "description"
```
