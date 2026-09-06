# Database

Postgres, via `pgvector/pgvector:pg16`. Ten tables, defined in
`kurisuassistant/db/models.py`. That file is the source of truth; this one
describes it.

## Schema

```
users
  id, username(unique), password(bcrypt)
  system_prompt, preferred_name, agent_avatar_uuid
  ollama_url, gemini_api_key, nvidia_api_key, poe_api_key   write-only over the API
  summary_model, summary_provider(default 'ollama') used for compaction + memory
  context_size
  tool_policies(JSON)                               {"tools": {name: allow|deny}}

assistants                                          exactly one row per user
  id, user_id→users (CASCADE, unique)
  model_name?, provider_type(default 'ollama')
  available_tools(JSON)?    null means every tool
  think(bool), use_deferred_tools(bool)
  memory(text)?             ONE document per user, shared by every persona
  memory_enabled(bool)
  trigger_word?             voice wake word; selects nothing
  default_persona_id→personas (SET NULL)            who answers a new conversation
  created_at

personas                                            presentation only
  id, user_id→users (CASCADE, NOT NULL)
  name, description, system_prompt
  voice_reference?, avatar_uuid?, character_config(JSON)?
  preferred_name?           what this persona calls the *user*
  enabled(bool), created_at
  unique (user_id, name)

sub_agents                                          task-only workers, no identity
  id, user_id→users (CASCADE)
  name, description, system_prompt
  model_name?, provider_type(default 'ollama')
  available_tools(JSON)?    null means every tool
  think(bool), use_deferred_tools(bool)
  enabled(bool), created_at
  unique (user_id, name)
  no memory column — see below

conversations
  id, user_id→users
  title
  persona_id→personas (SET NULL)    null until the first message binds one
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
  persona_id→personas (SET NULL)                    set on assistant messages only
  created_at

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

**Capability and presentation are separate rows.** `assistants` is one row per
user and holds everything the assistant can *do*; `personas` holds everything it
*is*, and there may be many. Migration
`0dacee9f63b8_split_persona_from_assistant` split the old `agents` table apart
again: sub-agents were copied out to `sub_agents` with fresh ids, one assistant
per user was built from that user's "winning" main agent (most messages, then most
recently used conversation, then lowest id), every non-empty memory was merged into
that one document, and `agents` was **renamed** to `personas`.

**Persona ids survived that rename on purpose.** Character assets live at
`data/character_assets/{persona_id}/` and the same id is embedded as a URL prefix
inside `character_config`. Two earlier migrations re-keyed and each had to
hand-write a directory rename plus a structured JSON URL rewrite to compensate;
one of them computed its data directory from a `DATA_DIR` environment variable
that `core/paths.py` never reads, so outside Docker it renamed nothing. The rename
avoids all of that, and the migration deliberately touches no files.

**The FK columns were renamed, not re-pointed.** `conversations.main_agent_id` is
now `conversations.persona_id` and `messages.agent_id` is now
`messages.persona_id`, both still `ON DELETE SET NULL`, and the values were left
untouched. Every REST response that carried the old names carries the new ones
(wire protocol 4).

**Sub-agents have no memory column, and that is not an oversight.** Consolidation
only ever joined through what is now `messages.persona_id`, which only ever held
main-agent ids, so a sub-agent's memory could never have been written. The split
dropped the column rather than keep one nothing could fill.

**Compaction uses a watermark, but the live path forks instead.**
`compacted_up_to_id` exists so context can be trimmed in place, and
`_load_context_messages` honours it. The current compaction path creates a *new*
conversation seeded with the summary (carrying the persona binding over) and sets
the watermark to 0, so in practice the watermark is never advanced. Two designs are
half-present; see the open issue on context accounting.

**Tool linkage is stored, and matters across providers.** `tool_calls` on the
assistant message and `tool_call_id` on the tool message keep a call paired with
its result when history is replayed. Ollama tolerates the pairing being absent;
OpenAI-compatible endpoints, which the NVIDIA provider speaks, reject it.

**Cascades are uneven.** `messages → conversations`,
`face_photos → face_identities`, and the three user-owned tables from the split
(`assistants`, `personas`, `sub_agents`) cascade in the database. The remaining
user-owned foreign keys — `conversations`, `skills`, `mcp_servers`,
`face_identities` — declare their cascade only on the ORM relationship, so a delete
that does not go through a loaded SQLAlchemy relationship leaves orphans.

**Indexing is thin.** `messages.conversation_id` is the only indexed foreign key,
and it is indexed alone rather than covering the sort. `face_photos.embedding`
has no vector index, so face matching is a sequential scan.

## Access

Every query goes through `DBService` — one thread, one queue, one connection at a
time. `await db.execute(op)` from the event loop; `execute_sync(op)` only from a
worker thread. The engine's pool is configured for 10 connections plus 20
overflow, which the single-threaded owner never uses.

That one thread must not be blockable without notice (#153). A failing operation
is logged with its traceback in `DBService._worker` before the exception reaches
the caller — refusals an operation raises on purpose (`HTTPException`,
`ValueError`) are logged at debug only. Both `execute` paths wait at most
`DB_OPERATION_TIMEOUT_SECONDS` (60) and then raise `DBUnavailableError`, which
`core/errors.py::internal_error` maps to a 503 and an app-level handler catches
when it escapes a dependency; an operation still queued when its caller gives up
is cancelled and never runs. The engine carries `connect_timeout`
(`DB_CONNECT_TIMEOUT_SECONDS`, 5) and a libpq `statement_timeout`
(`DB_STATEMENT_TIMEOUT_SECONDS`, 30) — Alembic builds its own engine in
`alembic/env.py`, so a long migration is not cut short.

Repositories live in `db/repositories/`, one per table over a generic
`BaseRepository` (`assistant.py`, `persona.py`, `sub_agent.py`, `conversation.py`,
`message.py`, `user.py`, `skill.py`, `mcp_server.py`, `face.py`). They take a
session; they never open one.

## Migrations

Alembic, 52 revisions with a single head (`485f1296faf8`, add_poe_api_key_to_users), replayable onto an empty
database. Run automatically by `docker-entrypoint.sh` before the app starts.

```bash
# from backend/
python -m scripts.migrate                       # apply
cd kurisuassistant/db && alembic revision -m "description"
```

The first run seeds nothing (#148); accounts are registered and then activated by
hand via `users.is_active`. It used to seed an `admin` / `admin` account and warn at startup while
that password is unchanged. Seeding — and registration — also calls
`core/accounts.py::provision_user`, which gives the account its one `assistants`
row and a first persona named `Assistant`. Without both, the account can log in
but cannot chat: a new conversation reads `assistants.default_persona_id` and there
is no fallback.
