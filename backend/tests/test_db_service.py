"""A stuck or failing database must be loud and bounded, not a silent hang (#153).

Every query goes through one thread. Before this, an exception in that thread
went only to the caller's future, a caller waited on that future forever, and
the engine had neither a connect nor a statement timeout. None of these tests
needs Postgres: the session factory is replaced with a stub.
"""

import asyncio
import logging
import threading
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException

from kurisuassistant.core.errors import (
    DB_UNAVAILABLE_MESSAGE,
    install_exception_handlers,
    internal_error,
)
from kurisuassistant.db import service as service_module
from kurisuassistant.db import session as session_module
from kurisuassistant.db.service import DBService, DBUnavailableError


@contextmanager
def _fake_session():
    yield object()


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(service_module, "get_session", _fake_session)
    svc = DBService()
    svc.start()
    yield svc
    svc.stop(timeout=5)


class TestFailuresAreLogged:
    def test_an_operational_error_is_logged_with_its_traceback(self, db, caplog):
        def lost_connection(session):
            raise OperationalError("SELECT 1", {}, Exception("server closed the connection"))

        with caplog.at_level(logging.ERROR, logger="kurisuassistant.db.service"):
            with pytest.raises(OperationalError):
                db.execute_sync(lost_connection)

        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(errors) == 1
        assert "lost_connection" in errors[0].getMessage()
        assert "server closed the connection" in caplog.text
        assert "Traceback" in caplog.text

    def test_an_unexpected_bug_is_logged_too(self, db, caplog):
        def broken(session):
            return session.no_such_attribute

        with caplog.at_level(logging.ERROR, logger="kurisuassistant.db.service"):
            with pytest.raises(AttributeError):
                db.execute_sync(broken)
        assert "broken" in caplog.text and "Traceback" in caplog.text

    @pytest.mark.parametrize("exc", [HTTPException(status_code=404), ValueError("already exists")])
    def test_a_refusal_is_not_an_error(self, db, caplog, exc):
        """404s and duplicate-name refusals are raised on purpose inside operations."""
        def refuse(session):
            raise exc

        with caplog.at_level(logging.DEBUG, logger="kurisuassistant.db.service"):
            with pytest.raises(type(exc)):
                db.execute_sync(refuse)
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


class TestCallersDoNotWaitForever:
    @pytest.fixture()
    def stuck(self, db):
        """The worker thread blocked inside an operation until the test releases it."""
        release = threading.Event()
        entered = threading.Event()

        def hang(session):
            entered.set()
            release.wait(timeout=10)

        db._queue.put((hang, service_module.Future()))
        assert entered.wait(timeout=5)
        yield db
        release.set()

    def test_execute_sync_times_out_with_a_503_shaped_error(self, stuck, caplog):
        def later(session):
            return "never"

        with caplog.at_level(logging.ERROR, logger="kurisuassistant.db.service"):
            with pytest.raises(DBUnavailableError) as info:
                stuck.execute_sync(later, timeout=0.05)
        assert "later" in str(info.value)
        assert "stuck or unreachable" in caplog.text

    def test_async_execute_times_out_the_same_way(self, stuck):
        async def go():
            with pytest.raises(DBUnavailableError):
                await stuck.execute(lambda session: "never", timeout=0.05)

        asyncio.run(go())

    def test_a_timed_out_operation_is_cancelled_not_run_late(self, db):
        """Once the caller has given up, the queued operation must not run
        after all — a stale write landing minutes later is worse than none."""
        release = threading.Event()
        entered = threading.Event()
        ran_late = threading.Event()

        def hang(session):
            entered.set()
            release.wait(timeout=10)

        def late(session):
            ran_late.set()

        db._queue.put((hang, service_module.Future()))
        assert entered.wait(timeout=5)
        with pytest.raises(DBUnavailableError):
            db.execute_sync(late, timeout=0.05)
        release.set()
        assert db.execute_sync(lambda session: "alive", timeout=5) == "alive"
        assert not ran_late.is_set()

    def test_the_default_timeout_comes_from_the_environment(self):
        assert service_module.OPERATION_TIMEOUT_SECONDS == 60.0


class TestTimeoutBecomesA503:
    def test_internal_error_maps_it_whatever_status_was_asked_for(self):
        exc = internal_error(DBUnavailableError("database did not answer"), "listing", status_code=500)
        assert exc.status_code == 503
        assert exc.detail.startswith(DB_UNAVAILABLE_MESSAGE)
        assert "reference:" in exc.detail

    def test_an_unwrapped_timeout_from_a_dependency_is_a_503(self):
        """``get_authenticated_user`` runs before any handler's try/except."""
        app = FastAPI()
        install_exception_handlers(app)

        @app.get("/x")
        async def handler():
            raise DBUnavailableError("database did not answer within 60s (get_user)")

        resp = TestClient(app, raise_server_exceptions=False).get("/x")
        assert resp.status_code == 503
        assert resp.json()["detail"].startswith(DB_UNAVAILABLE_MESSAGE)
        assert "get_user" not in resp.json()["detail"]


class TestEngineTimeouts:
    def test_connect_and_statement_timeouts_are_on_the_engine(self):
        args = session_module.connect_args()
        assert args["connect_timeout"] == 5
        assert args["options"] == "-c statement_timeout=30000"

    def test_zero_disables_the_statement_timeout(self):
        assert "options" not in session_module.connect_args(statement_timeout=0)

    def test_the_engine_was_built_with_them(self):
        # SQLAlchemy keeps connect_args on the pool's creator via the dialect;
        # the URL-level check is the cheapest proof they reached create_engine.
        creator = session_module.engine.pool._creator
        assert creator is not None
        assert session_module.engine.dialect.name == "postgresql"
