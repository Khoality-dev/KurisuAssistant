"""Onboarding a new account (#342): whether a client should offer it, on every device.

A new account has no model, no persona and no wake word, and the clients walk
it through them once. Whether that is still owed is the account's, not a
device's: finishing or skipping it on the desktop must stop Android from
asking. So the server keeps ``users.onboarded_at`` and reports
``onboarding_pending`` on ``GET /users/me`` — pending until a client says the
flow was finished or skipped, and never for an account that has a persona.

The migration test seeds accounts at the previous revision and runs the real
migration: an account that already set things up (a persona, or a model) is
counted as onboarded, so it never sees the flow.
"""

import os
import uuid

import pytest
import sqlalchemy as sa


@pytest.mark.db
class TestOnboarding:
    def _pending(self, account) -> bool:
        resp = account.client.get("/users/me", headers=account.headers)
        assert resp.status_code == 200, resp.text
        return resp.json()["onboarding_pending"]

    def test_a_new_account_is_owed_onboarding(self, account):
        assert self._pending(account) is True

    def test_finishing_or_skipping_ends_it_for_every_device(self, account):
        resp = account.client.patch("/users/me", json={"onboarded": True}, headers=account.headers)
        assert resp.status_code == 200, resp.text
        assert self._pending(account) is False
        # Saying it again changes nothing.
        account.client.patch("/users/me", json={"onboarded": True}, headers=account.headers)
        assert self._pending(account) is False

    def test_it_cannot_be_owed_again_by_a_client(self, account):
        resp = account.client.patch("/users/me", json={"onboarded": False}, headers=account.headers)
        assert resp.status_code == 422
        assert self._pending(account) is True

    def test_an_account_with_a_persona_is_never_asked(self, account):
        resp = account.client.post("/personas", json={"name": "Kurisu"}, headers=account.headers)
        assert resp.status_code in (200, 201), resp.text
        assert self._pending(account) is False

        # Deleting it again does not bring the flow back: it was set up once.
        persona_id = resp.json()["id"]
        account.client.delete(f"/personas/{persona_id}", headers=account.headers)
        assert self._pending(account) is False


# ── The migration ─────────────────────────────────────────────────────────────

PRE_ONBOARDING_REVISION = "09e29d2e5ef0"

FIXTURE = """
INSERT INTO users (id, username, password) VALUES (1, 'has-persona', 'x'), (2, 'has-model', 'x'), (3, 'new', 'x');
INSERT INTO personas (id, user_id, name, description, system_prompt, enabled) VALUES (10, 1, 'Kurisu', '', '', true);
INSERT INTO assistants (id, user_id, provider_type, think, use_deferred_tools, memory_enabled, model_name)
VALUES (1, 1, 'ollama', false, false, true, NULL),
       (2, 2, 'ollama', false, false, true, 'qwen3:8b'),
       (3, 3, 'ollama', false, false, true, NULL);
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
    from alembic import command
    from tests.postgres import require_postgres

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
        command.upgrade(config, PRE_ONBOARDING_REVISION)
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


@pytest.mark.db
def test_accounts_already_set_up_count_as_onboarded(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, "head")
    with engine.connect() as conn:
        rows = dict(conn.execute(sa.text("SELECT username, onboarded_at IS NOT NULL FROM users")).all())
    assert rows == {"has-persona": True, "has-model": True, "new": False}


@pytest.mark.db
def test_downgrade_drops_the_column(seeded_db):
    from alembic import command

    engine, config = seeded_db
    command.upgrade(config, "head")
    command.downgrade(config, PRE_ONBOARDING_REVISION)
    columns = {c["name"] for c in sa.inspect(engine).get_columns("users")}
    assert "onboarded_at" not in columns
