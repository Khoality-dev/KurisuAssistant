"""Migration coverage for 0dacee9f63b8 — splitting persona from assistant.

The interesting behaviour of that migration is invisible on an empty schema: the
winner rule, the memory merge, the App Guide deletion and the seeded persona all
only do something when there is data to move. So this seeds a database that
exercises every branch, runs the real migration through alembic, and asserts on
the result.

Marked ``integration``: it needs a Postgres it is allowed to create and drop
databases on. Point it at one with the usual POSTGRES_* variables — the same ones
``db/session.py`` and the alembic ``env.py`` read:

    POSTGRES_HOST=localhost POSTGRES_PORT=55432 pytest -m integration \
        tests/test_migration_persona_split.py

It never touches the configured application database: every run creates a fresh
throwaway database and drops it afterwards.
"""

import os
import uuid

import pytest
import sqlalchemy as sa

pytestmark = pytest.mark.integration

SPLIT_REVISION = "0dacee9f63b8"
PRE_SPLIT_REVISION = "d7b3e1c05a92"

# Three users, one per branch of the migration:
#   multi  — 3 main agents, differing capability, 2 non-empty memories. Bravo has the
#            most messages so Bravo must win, even though Alpha has the lower id.
#   single — 1 main agent with exactly one memory, which must survive verbatim.
#   empty  — no main agents at all, which must get a persona seeded from users.*.
FIXTURE = """
INSERT INTO users (id, username, password, system_prompt, preferred_name, agent_avatar_uuid)
VALUES (1, 'multi',  'x', 'multi prompt',  'Multi',  NULL),
       (2, 'single', 'x', 'single prompt', 'Single', NULL),
       (3, 'empty',  'x', 'empty prompt',  'Empty',  'avatar-uuid-3');

INSERT INTO agents (id, user_id, name, description, system_prompt, agent_type, enabled,
                    is_system, model_name, provider_type, available_tools, think,
                    use_deferred_tools, memory, memory_enabled, trigger_word,
                    voice_reference, preferred_name, character_config)
VALUES (101, 1, 'Alpha', '', 'alpha prompt', 'main', true, false, 'llama3', 'ollama',
        '["search"]', false, false, 'alpha remembers things', true, 'alpha', 'v1.wav', 'Al', NULL),
       (102, 1, 'Bravo', '', 'bravo prompt', 'main', true, false, 'gemini-2.0', 'gemini',
        NULL, true, true, 'bravo remembers other things', false, 'bravo', 'v2.wav', 'Bee', NULL),
       (103, 1, 'Charlie', '', 'charlie prompt', 'main', true, false, 'qwen', 'ollama',
        '["clock"]', false, false, '', true, NULL, NULL, NULL, NULL),
       (104, 1, 'worker', '', 'worker prompt', 'sub', true, false, 'qwen', 'ollama',
        '["search"]', false, false, 'never writable', true, NULL, NULL, NULL, NULL),
       (201, 2, 'Solo', '', 'solo prompt', 'main', true, false, 'llama3', 'ollama',
        '["clock","search"]', false, false, 'the only memory', true, 'solo', NULL, NULL,
        '{"poses": {"idle": "/character-assets/201/idle.png"}}');
SELECT setval('agents_id_seq', 300, true);

INSERT INTO conversations (id, user_id, title, main_agent_id, updated_at)
VALUES (1, 1, 'with alpha', 101, '2026-01-01'),
       (2, 1, 'with bravo', 102, '2026-08-01'),
       (3, 2, 'with solo',  201, '2026-08-02');
SELECT setval('conversations_id_seq', 10, true);

INSERT INTO messages (role, message, conversation_id, agent_id)
VALUES ('assistant', 'a1', 1, 101),
       ('assistant', 'b1', 2, 102),
       ('assistant', 'b2', 2, 102),
       ('assistant', 'b3', 2, 102),
       ('assistant', 's1', 3, 201);
"""


def _admin_url() -> str:
    user = os.getenv("POSTGRES_USER", "kurisu")
    password = os.getenv("POSTGRES_PASSWORD", "kurisu")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/postgres"


def _alembic_config(db_name: str):
    from alembic.config import Config

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_dir = os.path.join(here, "kurisuassistant", "db")
    config = Config(os.path.join(db_dir, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(db_dir, "alembic"))
    # env.py builds the URL from the environment, so the database name has to be
    # injected there rather than through sqlalchemy.url.
    os.environ["POSTGRES_DB"] = db_name
    return config


@pytest.fixture()
def migrated_db():
    """A throwaway database seeded at the pre-split revision, then migrated."""
    from alembic import command

    try:
        admin = sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"no Postgres available for migration tests: {exc}")

    db_name = f"kurisu_mig_{uuid.uuid4().hex[:12]}"
    previous_db = os.environ.get("POSTGRES_DB")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))

    config = _alembic_config(db_name)
    url = _admin_url().rsplit("/", 1)[0] + f"/{db_name}"
    engine = sa.create_engine(url)
    try:
        command.upgrade(config, PRE_SPLIT_REVISION)
        with engine.begin() as conn:
            conn.execute(sa.text(FIXTURE))
        command.upgrade(config, SPLIT_REVISION)
        yield engine, config
    finally:
        engine.dispose()
        if previous_db is None:
            os.environ.pop("POSTGRES_DB", None)
        else:
            os.environ["POSTGRES_DB"] = previous_db
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


def test_every_user_gets_exactly_one_assistant(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        orphans = conn.execute(
            sa.text(
                "SELECT count(*) FROM users u "
                "LEFT JOIN assistants a ON a.user_id = u.id WHERE a.id IS NULL"
            )
        ).scalar_one()
        assert orphans == 0, "a user with no assistant row cannot chat"

        duplicates = conn.execute(
            sa.text(
                "SELECT count(*) FROM (SELECT user_id FROM assistants "
                "GROUP BY user_id HAVING count(*) > 1) d"
            )
        ).scalar_one()
        assert duplicates == 0


def test_capability_winner_is_chosen_by_message_count(migrated_db):
    """Bravo has three messages to Alpha's one, so Bravo wins despite the higher id."""
    engine, _ = migrated_db
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(
                "SELECT model_name, provider_type, think, use_deferred_tools, "
                "memory_enabled, trigger_word, default_persona_id "
                "FROM assistants WHERE user_id = 1"
            )
        ).one()
    assert row.model_name == "gemini-2.0"
    assert row.provider_type == "gemini"
    assert row.think is True
    assert row.use_deferred_tools is True
    # memory_enabled takes the winner's value uniformly; an OR across agents would
    # silently re-enable a setting the user deliberately turned off.
    assert row.memory_enabled is False
    assert row.trigger_word == "bravo"
    assert row.default_persona_id == 102


def test_every_main_agent_survives_as_a_persona(migrated_db):
    """No persona is dropped: only capability is unified."""
    engine, _ = migrated_db
    with engine.connect() as conn:
        names = [
            r.name
            for r in conn.execute(
                sa.text("SELECT name FROM personas WHERE user_id = 1 ORDER BY id")
            )
        ]
    assert names == ["Alpha", "Bravo", "Charlie"]


def test_memories_merge_with_headers_only_when_there_is_more_than_one(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        multi = conn.execute(
            sa.text("SELECT memory FROM assistants WHERE user_id = 1")
        ).scalar_one()
        single = conn.execute(
            sa.text("SELECT memory FROM assistants WHERE user_id = 2")
        ).scalar_one()

    # Winner first, and Charlie's empty memory contributes nothing.
    assert multi.index('## From "Bravo"') < multi.index('## From "Alpha"')
    assert "bravo remembers other things" in multi
    assert "alpha remembers things" in multi
    assert "Charlie" not in multi

    # A single memory is copied verbatim. Adding a header here would rewrite every
    # existing single-agent user's memory, and consolidation would perpetuate it.
    assert single == "the only memory"


def test_sub_agents_move_out_and_lose_memory(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT name, model_name, user_id FROM sub_agents")
        ).all()
        assert [(r.name, r.model_name, r.user_id) for r in rows] == [("worker", "qwen", 1)]

        assert "worker" not in [
            r.name for r in conn.execute(sa.text("SELECT name FROM personas"))
        ]
        columns = {
            r.column_name
            for r in conn.execute(
                sa.text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'sub_agents'"
                )
            )
        }
        assert "memory" not in columns
        assert "memory_enabled" not in columns


def test_app_guide_is_deleted_and_is_system_is_gone(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        assert (
            conn.execute(
                sa.text("SELECT count(*) FROM personas WHERE name = 'App Guide'")
            ).scalar_one()
            == 0
        )
        columns = {
            r.column_name
            for r in conn.execute(
                sa.text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'personas'"
                )
            )
        }
    # Capability and the discriminators are gone from personas entirely.
    for dead in (
        "model_name", "provider_type", "available_tools", "think", "use_deferred_tools",
        "memory", "memory_enabled", "agent_type", "is_system", "trigger_word",
    ):
        assert dead not in columns, f"personas.{dead} should have been dropped"


def test_persona_ids_are_preserved_so_character_assets_still_resolve(migrated_db):
    """The ids are load-bearing off-database: data/character_assets/{id}/ and the
    same id embedded as a URL prefix inside character_config."""
    engine, _ = migrated_db
    with engine.connect() as conn:
        ids = [r.id for r in conn.execute(sa.text("SELECT id FROM personas ORDER BY id"))]
        assert {101, 102, 103, 201} <= set(ids)

        config = conn.execute(
            sa.text("SELECT character_config FROM personas WHERE id = 201")
        ).scalar_one()
        assert "/character-assets/201/" in str(config), "asset URLs must not be rewritten"


def test_conversation_and_message_bindings_survive(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        bindings = {
            r.id: r.persona_id
            for r in conn.execute(sa.text("SELECT id, persona_id FROM conversations"))
        }
        assert bindings == {1: 101, 2: 102, 3: 201}

        unbound = conn.execute(
            sa.text("SELECT count(*) FROM messages WHERE persona_id IS NULL")
        ).scalar_one()
        assert unbound == 0


def test_user_without_main_agents_gets_a_seeded_persona(migrated_db):
    engine, _ = migrated_db
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(
                "SELECT p.id, p.name, p.system_prompt, p.preferred_name, p.avatar_uuid "
                "FROM personas p WHERE p.user_id = 3"
            )
        ).one()
        assert row.name == "Assistant"
        assert row.system_prompt == "empty prompt"
        assert row.preferred_name == "Empty"
        assert row.avatar_uuid == "avatar-uuid-3"

        default = conn.execute(
            sa.text("SELECT default_persona_id FROM assistants WHERE user_id = 3")
        ).scalar_one()
        assert default == row.id, "the seeded persona must become the default"


def test_downgrade_fuses_back_and_is_honest_about_the_loss(migrated_db):
    from alembic import command

    engine, config = migrated_db
    command.downgrade(config, PRE_SPLIT_REVISION)

    with engine.connect() as conn:
        for gone in ("assistants", "sub_agents", "personas"):
            assert (
                conn.execute(sa.text(f"SELECT to_regclass('{gone}')")).scalar_one() is None
            )

        rows = {
            r.name: r
            for r in conn.execute(
                sa.text("SELECT name, agent_type, model_name FROM agents")
            )
        }
        assert rows["worker"].agent_type == "sub"
        # The documented loss: per-agent capability was discarded on the way up, so
        # every persona comes back stamped with the winner's model.
        assert rows["Alpha"].model_name == "gemini-2.0"
        assert rows["Charlie"].model_name == "gemini-2.0"

        assert (
            conn.execute(
                sa.text("SELECT main_agent_id FROM conversations WHERE id = 1")
            ).scalar_one()
            == 101
        )
