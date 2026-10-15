"""Migration coverage for #354 — one persona in use for the whole account.

A conversation is no longer tied to a persona, and sub-agents are no longer rows
the user sets up: the assistant spawns one when it needs help. So the migration
drops ``conversations.persona_id`` and the ``sub_agents`` table. Neither drop is
visible on an empty schema, so this seeds a conversation bound to a persona, a
message that persona wrote and a saved sub-agent at the previous revision, runs
the real migration through alembic, and asserts on what is left.

Marked ``db``: it needs a Postgres it is allowed to create and drop databases
on, through the usual ``POSTGRES_*`` variables. It never touches the configured
application database.
"""

import os
import uuid

import pytest
import sqlalchemy as sa
from tests.postgres import require_postgres

pytestmark = pytest.mark.db

PRE_GLOBAL_PERSONA_REVISION = "40309c742302"

FIXTURE = """
INSERT INTO users (id, username, password) VALUES (1, 'owner', 'x');
INSERT INTO personas (id, user_id, name, description, system_prompt, enabled)
VALUES (10, 1, 'Kurisu', '', 'Be sarcastic.', true);
INSERT INTO assistants (id, user_id, provider_type, think, use_deferred_tools, memory_enabled, selected_persona_id)
VALUES (1, 1, 'ollama', false, false, true, 10);
INSERT INTO conversations (id, user_id, title, persona_id) VALUES (100, 1, 'Weekend plans', 10);
INSERT INTO messages (id, role, message, conversation_id, persona_id)
VALUES (1000, 'assistant', 'Hello.', 100, 10);
INSERT INTO sub_agents (id, user_id, name, description, system_prompt, provider_type, think,
                        use_deferred_tools, enabled)
VALUES (50, 1, 'Researcher', 'Looks things up', 'You are a researcher.', 'ollama', false, false, true);
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
    os.environ["POSTGRES_DB"] = db_name
    return config


@pytest.fixture()
def seeded_db():
    """A throwaway database seeded at the revision before #354; the test drives alembic."""
    from alembic import command

    try:
        admin = sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        require_postgres(exc, "migration tests")

    db_name = f"kurisu_mig_{uuid.uuid4().hex[:12]}"
    previous_db = os.environ.get("POSTGRES_DB")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))

    config = _alembic_config(db_name)
    url = _admin_url().rsplit("/", 1)[0] + f"/{db_name}"
    engine = sa.create_engine(url)
    try:
        command.upgrade(config, PRE_GLOBAL_PERSONA_REVISION)
        with engine.begin() as conn:
            conn.execute(sa.text(FIXTURE))
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


def _columns(engine, table: str) -> set:
    return {c["name"] for c in sa.inspect(engine).get_columns(table)}


def _tables(engine) -> set:
    return set(sa.inspect(engine).get_table_names())


def test_upgrade_unties_conversations_and_drops_saved_sub_agents(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, "head")

    assert "persona_id" not in _columns(engine, "conversations"), "a conversation is not tied to a persona"
    assert "sub_agents" not in _tables(engine), "saved sub-agents are removed"

    with engine.connect() as conn:
        conversation = conn.execute(sa.text("SELECT id, title FROM conversations")).one()
        message = conn.execute(sa.text("SELECT id, persona_id FROM messages")).one()
        selected = conn.execute(sa.text("SELECT selected_persona_id FROM assistants")).scalar_one()
        persona = conn.execute(sa.text("SELECT id, name FROM personas")).one()

    assert tuple(conversation) == (100, "Weekend plans"), "the conversation itself stays"
    assert tuple(message) == (1000, 10), "a message still records who wrote it"
    assert selected == 10, "the persona in use is untouched"
    assert tuple(persona) == (10, "Kurisu")


def test_downgrade_restores_the_schema_but_not_the_lost_rows(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, "head")
    command.downgrade(config, PRE_GLOBAL_PERSONA_REVISION)

    assert "persona_id" in _columns(engine, "conversations")
    assert "sub_agents" in _tables(engine)
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT persona_id FROM conversations")).scalar_one() is None
        assert conn.execute(sa.text("SELECT count(*) FROM sub_agents")).scalar_one() == 0
