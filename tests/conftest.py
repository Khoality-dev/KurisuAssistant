"""Shared test fixtures."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import tts, asr


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
