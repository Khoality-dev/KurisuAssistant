"""Shared test fixtures.

Environment first. ``kurisuassistant.db.session`` builds its engine from the
``POSTGRES_*`` variables at import, so the database name every test module ends
up bound to has to be fixed here, before anything from the package is imported. A
fresh name per session keeps the suite off any real database; ``system_db``
creates and drops it. ``JWT_SECRET_KEY`` stops ``core/security.py`` writing a key
file under ``data/`` at import.
"""

import os
import uuid

os.environ.setdefault("JWT_SECRET_KEY", "test-not-a-real-secret")
os.environ["POSTGRES_DB"] = f"kurisu_test_{uuid.uuid4().hex[:8]}"

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from kurisuassistant.core.deps import get_authenticated_user  # noqa: E402
from kurisuassistant.routers import tts, asr  # noqa: E402


def _fake_user():
    """Stub user for auth bypass."""
    return type("User", (), {"id": 1, "username": "test"})()


@pytest.fixture()
def app():
    """FastAPI app with TTS + ASR routers and auth bypassed."""
    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = _fake_user
    app.include_router(tts.router)
    app.include_router(asr.router)
    return app


@pytest.fixture()
def client(app):
    return TestClient(app)


# ---------------------------------------------------------------------------
# Mock Ollama — one server per session, reset between tests
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def mock_ollama_server():
    """The mock Ollama on a background thread for the whole session."""
    from tests.mock_ollama import MockOllamaServer

    with MockOllamaServer() as server:
        yield server


@pytest.fixture()
def mock_ollama(mock_ollama_server):
    """The session's mock Ollama with a clean slate: default model, no scripted
    replies, empty request log. Point a provider at ``mock_ollama.url``; script
    with ``mock_ollama.state.script(Reply(...))``."""
    mock_ollama_server.state.reset()
    yield mock_ollama_server
    mock_ollama_server.state.reset()


# ---------------------------------------------------------------------------
# System tests — the real app on a fresh Postgres database
# ---------------------------------------------------------------------------

def _postgres_admin_url() -> str:
    user = os.getenv("POSTGRES_USER", "kurisu")
    password = os.getenv("POSTGRES_PASSWORD", "kurisu")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/postgres"


SYSTEM_TEST_USER = "tester"
SYSTEM_TEST_PASSWORD = "tester-password"


def _create_activated_user(username: str, password: str) -> None:
    """Register an account and activate it, as the operator would by hand."""
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        repo = UserRepository(session)
        user = repo.create_user(username, hash_password(password))
        provision_user(session, user)
        user.is_active = True


@pytest.fixture(scope="session")
def system_db():
    """A fresh database migrated to head, with one activated test account.

    Nothing is seeded any more (#148), so the suite makes its own account and
    activates it the way an operator would — which also keeps the activation
    gate itself under test rather than assumed.

    Skips when no Postgres answers — except on CI, where the workflow provides one
    and a skip would hide a broken suite.
    """
    import sqlalchemy as sa

    db_name = os.environ["POSTGRES_DB"]
    try:
        admin = sa.create_engine(_postgres_admin_url(), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text(f'CREATE DATABASE "{db_name}"'))
    except Exception as exc:  # pragma: no cover - environment dependent
        if os.environ.get("CI"):
            raise
        pytest.skip(f"no Postgres for system tests (set POSTGRES_HOST/PORT): {exc}")

    from kurisuassistant.db.init import init_db

    init_db()
    _create_activated_user(SYSTEM_TEST_USER, SYSTEM_TEST_PASSWORD)
    yield db_name

    from kurisuassistant.db.session import engine

    engine.dispose()
    with admin.connect() as conn:
        conn.execute(
            sa.text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :db AND pid <> pg_backend_pid()"),
            {"db": db_name},
        )
        conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{db_name}"'))
    admin.dispose()


@pytest.fixture(scope="session")
def system_client(system_db, mock_ollama_server):
    """The real FastAPI app, lifespan running, with Ollama pointed at the mock.

    ``OllamaProvider`` reads ``LLM_API_URL`` when it is built (once per turn), so
    setting it here reaches every chat, compaction and consolidation call.
    """
    os.environ["LLM_API_URL"] = mock_ollama_server.url
    from kurisuassistant.main import app

    with TestClient(app) as client:
        yield client
