# Database

Postgres, via `pgvector/pgvector:pg16`. Eight tables, defined in
`kurisuassistant/db/models.py`. That file is the source of truth; this one
describes it.

## Schema

```
users
  id, username(unique), password(bcrypt)
  system_prompt, preferred_name, agent_avatar_uuid
  ollama_url, gemini_api_key, nvidia_api_key        write-only over the API
  summary_model, summary_provider(default 'ollama') used for compaction + memory
  context_size
  tool_policies(JSON)                               {"tools": {name: allow|deny}}

conversations
  id, user_id→users
  title
  main_agent_id→agents (SET NULL)   null until the first message picks one
  compacted_context(text, not null, default '')
  compacted_up_to_id(int, not null, default 0)
  created_at, updated_at

messages
  id, role, message
  thinking?, raw_input?, raw_output?
  name?, model_name?, provider_type?
  tool_args(JSON)?, tool_status?                    on a tool message
  tool_calls(JSON)?                                 on the assistant message that made them
  tool_call_id?                                     on the tool message answering one
  context_files(JSON)?, images(JSON, list of UUIDs)?
  conversation_id→conversations (CASCADE, indexed)
  agent_id→agents (SET NULL)
  created_at

agents
  id, user_id→users (null for system agents)
  name, description, system_prompt
  voice_reference?, avatar_uuid?, character_config(JSON)?    main agents only
  preferred_name?, trigger_word?                            main agents only
  model_name?, provider_type(default 'ollama')
  available_tools(JSON)?    null means every tool
  think(bool), use_deferred_tools(bool)
  agent_type('main'|'sub'), memory(text)?, memory_enabled(bool)
  enabled(bool), is_system(bool), created_at
  unique (user_id, name)

skills          id, user_id→users, name, instructions, created_at   unique (user_id, name)
mcp_servers     id, user_id→users, name, transport_type('sse'|'stdio'),
                url?, command?, args(JSON)?, env(JSON)?, enabled, location('server'|'client'),
                created_at                                          unique (user_id, name)
face_identities id, user_id→users, name, created_at                 unique (user_id, name)
face_photos     id, identity_id→face_identities (CASCADE),
                embedding(vector(512)), photo_uuid, created_at
```

Media is not stored here. Images, voice clips and character assets are files
under `data/`, referenced by the UUID columns above.

## Things worth knowing

**Compaction uses a watermark, but the live path forks instead.**
`compacted_up_to_id` exists so context can be trimmed in place, and
`_load_context_messages` honours it. The current compaction path creates a *new*
conversation seeded with the summary and sets the watermark to 0, so in practice
the watermark is never advanced. Two designs are half-present; see the open issue
on context accounting.

**Tool linkage is stored, and matters across providers.** `tool_calls` on the
assistant message and `tool_call_id` on the tool message keep a call paired with
its result when history is replayed. Ollama tolerates the pairing being absent;
OpenAI-compatible endpoints, which the NVIDIA provider speaks, reject it.

**Cascades are uneven.** `messages → conversations` and
`face_photos → face_identities` cascade in the database. The user-owned foreign
keys declare their cascade only on the ORM relationship, so a delete that does
not go through a loaded SQLAlchemy relationship leaves orphans.

**Indexing is thin.** `messages.conversation_id` is the only indexed foreign key,
and it is indexed alone rather than covering the sort. `face_photos.embedding`
has no vector index, so face matching is a sequential scan.

## Access

Every query goes through `DBService` — one thread, one queue, one connection at a
time. `await db.execute(op)` from the event loop; `execute_sync(op)` only from a
worker thread. The engine's pool is configured for 10 connections plus 20
overflow, which the single-threaded owner never uses.

Repositories live in `db/repositories/`, one per table over a generic
`BaseRepository`. They take a session; they never open one.

## Migrations

Alembic, 50 revisions with a single head, replayable onto an empty database. Run
automatically by `docker-entrypoint.sh` before the app starts.

```bash
# from backend/
python -m scripts.migrate                       # apply
cd kurisuassistant/db && alembic revision -m "description"
```

The first run also seeds an `admin` / `admin` account and warns at startup while
that password is unchanged.
