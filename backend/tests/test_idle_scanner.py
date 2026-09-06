"""The idle scanner is bounded, remembers what it did, and retries what failed (#96).

Before: every conversation the user had ever finished was selected every minute
(no index, no limit), the dedupe set lived in memory (a failure wedged the
conversation until restart; a restart forgot what was pending) and a failed
consolidation was never retried. Now the state is on the ``conversations`` row.

The scan and the task handler are driven directly — no worker threads — against
the migrated test database; the model call is replaced, since what is under test
is the bookkeeping around it, not the summary.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta

import pytest
import sqlalchemy as sa

from kurisuassistant.workers import service as worker_module
from kurisuassistant.workers.service import BackgroundService, MAX_ATTEMPTS, retry_delay
from kurisuassistant.workers.tasks import ConsolidateMemoryTask

pytestmark = pytest.mark.db

IDLE = timedelta(minutes=worker_module.CONVERSATION_IDLE_THRESHOLD_MINUTES + 5)


class TestBackoff:
    def test_doubles_from_five_minutes_and_caps(self):
        assert [retry_delay(n).total_seconds() / 60 for n in (1, 2, 3, 4, 5)] == [5, 10, 20, 40, 80]
        assert retry_delay(20) == timedelta(minutes=worker_module.RETRY_MAX_MINUTES)


# ---------------------------------------------------------------------------
# Database-backed
# ---------------------------------------------------------------------------

@pytest.fixture()
def db(system_db):
    """The DB service on the migrated test database, with the tester's summary
    model set so the scan actually queues something."""
    from kurisuassistant.db import service as service_module
    from kurisuassistant.db.models import User

    started_here = service_module._service is None
    if started_here:
        service_module.start_db_service()
    svc = service_module.get_db_service()

    def _prefs(session):
        user = session.query(User).filter_by(username="tester").one()
        user.summary_model = "test-model"
        return user.id

    user_id = svc.execute_sync(_prefs)
    yield svc, user_id
    if started_here:
        service_module.stop_db_service()


def _conversation(db, user_id, *, age=IDLE, messages=1, **fields):
    """One conversation, ``age`` old, with ``messages`` messages."""
    from kurisuassistant.db.models import Conversation, Message

    def _make(session):
        conv = Conversation(user_id=user_id, title=uuid.uuid4().hex,
                            updated_at=datetime.utcnow() - age, **fields)
        session.add(conv)
        session.flush()
        for i in range(messages):
            session.add(Message(conversation_id=conv.id, role="user", message=f"m{i}"))
        return conv.id

    return db.execute_sync(_make)


def _row(db, conv_id):
    from kurisuassistant.db.models import Conversation

    def _get(session):
        c = session.get(Conversation, conv_id)
        return {
            "updated_at": c.updated_at,
            "consolidated_at": c.consolidated_at,
            "attempts": c.consolidation_attempts,
            "next_retry_at": c.consolidation_next_retry_at,
        }

    return db.execute_sync(_get)


def _scan(svc: BackgroundService) -> list[int]:
    """Run one scan and return the conversation ids it queued."""
    queued: list[int] = []
    svc.submit = lambda task: queued.append(task.conversation_id)  # type: ignore[method-assign]
    svc._scan_idle_conversations()
    return queued


def _run(svc: BackgroundService, conv_id: int, user_id: int):
    asyncio.run(svc._handle_consolidate(ConsolidateMemoryTask(
        user_id=user_id, conversation_id=conv_id, model_name="test-model",
        api_url=None, provider_type="ollama", api_key=None,
    )))


class TestTheScanIsBounded:
    def test_only_idle_unconsolidated_due_conversations_are_queued(self, db):
        svc_db, user_id = db
        due = _conversation(svc_db, user_id)
        already_done = _conversation(svc_db, user_id, consolidated_at=datetime.utcnow())
        changed_since = _conversation(svc_db, user_id,
                                      consolidated_at=datetime.utcnow() - IDLE - timedelta(hours=1))
        waiting_for_retry = _conversation(
            svc_db, user_id, consolidation_next_retry_at=datetime.utcnow() + timedelta(minutes=10))
        still_active = _conversation(svc_db, user_id, age=timedelta(minutes=1))
        empty = _conversation(svc_db, user_id, messages=0)

        queued = _scan(BackgroundService())

        assert due in queued
        assert changed_since in queued, "consolidated before its last change is due again"
        for conv in (already_done, waiting_for_retry, still_active, empty):
            assert conv not in queued

    def test_at_most_scan_limit_oldest_first(self, db, monkeypatch):
        svc_db, user_id = db
        monkeypatch.setattr(worker_module, "SCAN_LIMIT", 2)
        # Nothing else in the table is due: earlier tests' rows are consolidated
        # or stamped, and these three are older than anything else.
        oldest = _conversation(svc_db, user_id, age=IDLE + timedelta(days=30))
        older = _conversation(svc_db, user_id, age=IDLE + timedelta(days=20))
        old = _conversation(svc_db, user_id, age=IDLE + timedelta(days=10))

        queued = _scan(BackgroundService())

        assert len(queued) == 2
        assert queued == [oldest, older]
        assert old not in queued

    def test_updated_at_is_indexed(self, db):
        svc_db, _ = db

        def _indexes(session):
            return {ix["name"] for ix in sa.inspect(session.get_bind()).get_indexes("conversations")}

        assert "ix_conversations_updated_at" in svc_db.execute_sync(_indexes)


class TestOutcomesAreRecorded:
    def test_success_stamps_the_row_and_the_next_scan_skips_it(self, db, monkeypatch):
        svc_db, user_id = db
        conv = _conversation(svc_db, user_id, consolidation_attempts=2,
                             consolidation_next_retry_at=datetime.utcnow() - timedelta(minutes=1))

        async def ok(**kwargs):
            return None

        monkeypatch.setattr("kurisuassistant.utils.memory_consolidation.consolidate_assistant_memory", ok)
        svc = BackgroundService()
        assert conv in _scan(svc)

        _run(svc, conv, user_id)

        row = _row(svc_db, conv)
        assert row["consolidated_at"] is not None and row["consolidated_at"] > row["updated_at"]
        assert row["attempts"] == 0 and row["next_retry_at"] is None
        assert conv not in _scan(svc)
        assert conv not in svc._queued

    def test_failure_schedules_a_retry_and_a_later_scan_picks_it_up(self, db, monkeypatch, caplog):
        svc_db, user_id = db
        conv = _conversation(svc_db, user_id)

        async def boom(**kwargs):
            raise ConnectionError("model host unreachable")

        monkeypatch.setattr("kurisuassistant.utils.memory_consolidation.consolidate_assistant_memory", boom)
        svc = BackgroundService()
        assert conv in _scan(svc)

        with caplog.at_level(logging.WARNING, logger=worker_module.__name__):
            _run(svc, conv, user_id)

        row = _row(svc_db, conv)
        assert row["consolidated_at"] is None
        assert row["attempts"] == 1
        assert row["next_retry_at"] is not None
        assert timedelta(minutes=4) < row["next_retry_at"] - datetime.utcnow() <= timedelta(minutes=5)
        assert "attempt 1/%d" % MAX_ATTEMPTS in caplog.text
        assert conv not in svc._queued, "the reservation is released even on failure"
        assert conv not in _scan(svc), "not before the retry is due"

        def _due_now(session):
            from kurisuassistant.db.models import Conversation
            session.get(Conversation, conv).consolidation_next_retry_at = datetime.utcnow() - timedelta(seconds=1)

        svc_db.execute_sync(_due_now)
        assert conv in _scan(svc), "due again once the backoff has passed"

    def test_backoff_grows_with_each_failure(self, db, monkeypatch):
        svc_db, user_id = db
        conv = _conversation(svc_db, user_id, consolidation_attempts=2)

        async def boom(**kwargs):
            raise RuntimeError("still broken")

        monkeypatch.setattr("kurisuassistant.utils.memory_consolidation.consolidate_assistant_memory", boom)
        _run(BackgroundService(), conv, user_id)

        row = _row(svc_db, conv)
        assert row["attempts"] == 3
        assert timedelta(minutes=19) < row["next_retry_at"] - datetime.utcnow() <= timedelta(minutes=20)

    def test_an_exhausted_conversation_is_left_alone_until_it_changes(self, db, monkeypatch, caplog):
        svc_db, user_id = db
        conv = _conversation(svc_db, user_id, consolidation_attempts=MAX_ATTEMPTS - 1)

        async def boom(**kwargs):
            raise RuntimeError("bad summary model")

        monkeypatch.setattr("kurisuassistant.utils.memory_consolidation.consolidate_assistant_memory", boom)
        svc = BackgroundService()
        with caplog.at_level(logging.ERROR, logger=worker_module.__name__):
            _run(svc, conv, user_id)

        row = _row(svc_db, conv)
        assert row["attempts"] == MAX_ATTEMPTS
        assert row["consolidated_at"] is not None
        assert row["next_retry_at"] is None
        assert "giving up" in caplog.text
        assert conv not in _scan(svc)

        # New activity makes it due again, from a clean count.
        def _touch(session):
            from kurisuassistant.db.models import Conversation
            c = session.get(Conversation, conv)
            c.updated_at = datetime.utcnow() - IDLE  # idle again, but changed since the stamp
            c.consolidated_at = c.updated_at - timedelta(hours=1)

        svc_db.execute_sync(_touch)
        assert conv in _scan(svc)

    def test_consolidation_failures_reach_the_handler(self, db):
        """``consolidate_assistant_memory`` used to swallow every exception, so
        the handler could never have known to schedule a retry."""
        from kurisuassistant.utils.memory_consolidation import consolidate_assistant_memory

        svc_db, user_id = db
        conv = _conversation(svc_db, user_id)
        with pytest.raises(Exception):
            asyncio.run(consolidate_assistant_memory(
                user_id=user_id, conversation_id=conv, model_name="test-model",
                api_url="http://127.0.0.1:9",  # nothing listens here
            ))


# ---------------------------------------------------------------------------
# The migration itself
# ---------------------------------------------------------------------------

REVISION = "c2d999801f26"
PREVIOUS = "a1f4c7d92b3e"


def _admin_url() -> str:
    user = os.getenv("POSTGRES_USER", "kurisu")
    password = os.getenv("POSTGRES_PASSWORD", "kurisu")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/postgres"


@pytest.fixture()
def throwaway_db():
    """A fresh database at the previous revision, with one old conversation."""
    from alembic import command
    from alembic.config import Config

    try:
        admin = sa.create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        if os.environ.get("CI"):
            raise
        pytest.skip(f"no Postgres available for migration tests: {exc}")

    db_name = f"kurisu_mig_{uuid.uuid4().hex[:12]}"
    previous_db = os.environ.get("POSTGRES_DB")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    db_dir = os.path.join(here, "kurisuassistant", "db")
    config = Config(os.path.join(db_dir, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(db_dir, "alembic"))
    os.environ["POSTGRES_DB"] = db_name
    engine = sa.create_engine(_admin_url().rsplit("/", 1)[0] + f"/{db_name}")
    try:
        command.upgrade(config, PREVIOUS)
        with engine.begin() as conn:
            conn.execute(sa.text(
                "INSERT INTO users (id, username, password) VALUES (1, 'u', 'x');"
                "INSERT INTO conversations (id, user_id, title, updated_at) "
                "VALUES (1, 1, 'old', '2026-01-01 00:00:00');"
            ))
        yield engine, config, command
    finally:
        engine.dispose()
        if previous_db is None:
            os.environ.pop("POSTGRES_DB", None)
        else:
            os.environ["POSTGRES_DB"] = previous_db
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


class TestMigration:
    def test_upgrade_backfills_and_indexes_and_downgrade_undoes_it(self, throwaway_db):
        engine, config, command = throwaway_db

        command.upgrade(config, REVISION)
        with engine.connect() as conn:
            row = conn.execute(sa.text(
                "SELECT updated_at, consolidated_at, consolidation_attempts, consolidation_next_retry_at "
                "FROM conversations WHERE id = 1")).one()
            assert row.consolidated_at == row.updated_at, "existing history counts as consolidated"
            assert row.consolidation_attempts == 0 and row.consolidation_next_retry_at is None
            indexes = {ix["name"] for ix in sa.inspect(conn).get_indexes("conversations")}
            assert "ix_conversations_updated_at" in indexes
            # The autogenerate trap (#162): this revision must not touch it.
            face_indexes = {ix["name"] for ix in sa.inspect(conn).get_indexes("face_photos")}
            assert "ix_face_photos_embedding_hnsw" in face_indexes

        command.downgrade(config, PREVIOUS)
        with engine.connect() as conn:
            columns = {c["name"] for c in sa.inspect(conn).get_columns("conversations")}
            assert not columns & {"consolidated_at", "consolidation_attempts", "consolidation_next_retry_at"}
            indexes = {ix["name"] for ix in sa.inspect(conn).get_indexes("conversations")}
            assert "ix_conversations_updated_at" not in indexes
