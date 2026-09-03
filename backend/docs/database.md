# Database

## Schema

```
User: id, username, password(bcrypt), system_prompt, preferred_name, user_avatar_uuid, agent_avatar_uuid, ollama_url, summary_model(nullable, required for summarization+memory)
Conversation: id, user_id→User, title, created_at, updated_at
Frame: id, conversation_id→Conversation, summary?, created_at, updated_at
Message: id, role, message, thinking?, raw_input?, raw_output?, name?, images(JSON, list of UUIDs)?, frame_id→Frame, agent_id→Agent(SET NULL), created_at
Agent: id, user_id→User, name, system_prompt, voice_reference, avatar_uuid, model_name, excluded_tools(JSON), think(bool), memory(text?), memory_enabled(bool, default true), trigger_word(string?), created_at
FaceIdentity: id, user_id→User, name(unique per user), created_at
FacePhoto: id, identity_id→FaceIdentity(CASCADE), embedding(vector(512)), photo_uuid, created_at
Skill: id, user_id→User, name(unique per user), instructions(text), created_at
MCPServer: id, user_id→User, name(unique per user), transport_type(sse|stdio), url?, command?, args(JSON)?, env(JSON)?, enabled(bool), location(server|client, default server), created_at
```

## Session Management

Connection pool: 10 + 20 overflow, 1hr recycle, pre-ping enabled. Configured in `db/session.py`.

## Migrations

Managed with Alembic. Auto-run on Docker container startup via `docker-entrypoint.sh`.

```bash
# Create a new migration
cd db && alembic revision --autogenerate -m "description"

# Run migrations manually
python -m scripts.migrate
```

First migration seeds default `admin:admin` account.
