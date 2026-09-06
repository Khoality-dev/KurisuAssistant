"""``GET /models`` says when a provider cannot be reached (#151).

Before: an unreachable Ollama answered 200 with an empty list, which reads as
"no models installed" — the failure a first-run user with a wrong
``LLM_API_URL`` is most likely to misdiagnose.
"""

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import models as models_router


class _User:
    id = 1
    username = "test"
    ollama_url = None
    gemini_api_key = None
    nvidia_api_key = None
    poe_api_key = None


@pytest.fixture()
def user():
    return _User()


@pytest.fixture()
def client(user):
    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = lambda: user
    app.include_router(models_router.router)
    return TestClient(app, raise_server_exceptions=False)


def _refuse(*args, **kwargs):
    raise ConnectionError("connection refused")


class TestUnreachableOllama:
    def test_no_provider_reachable_is_a_502_that_names_the_cause(self, client):
        with patch.object(models_router, "llm_list_models", _refuse):
            resp = client.get("/models")
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert "Ollama server is unreachable" in detail
        assert "LLM_API_URL" in detail
        assert "reference:" in detail
        assert "connection refused" not in detail

    def test_a_reachable_server_with_no_models_is_an_honest_empty_list(self, client):
        with patch.object(models_router, "llm_list_models", lambda api_url=None: []):
            resp = client.get("/models")
        assert resp.status_code == 200
        assert resp.json() == {"models": [], "unavailable": []}

    def test_ollama_down_but_a_keyed_provider_up_is_degraded_not_failed(self, client, user):
        user.gemini_api_key = "k"

        class FakeGemini:
            def list_models(self):
                return ["gemini-2.5-flash"]

        with patch.object(models_router, "llm_list_models", _refuse), \
                patch.object(models_router, "create_llm_provider", lambda *a, **k: FakeGemini()):
            resp = client.get("/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body["models"] == [{"name": "gemini-2.5-flash", "provider": "gemini"}]
        assert [u["provider"] for u in body["unavailable"]] == ["ollama"]
        assert "unreachable" in body["unavailable"][0]["detail"]

    def test_a_keyed_provider_failure_is_reported_by_name(self, client, user):
        user.poe_api_key = "k"

        class BrokenPoe:
            def list_models(self):
                raise RuntimeError("502 from poe")

        with patch.object(models_router, "llm_list_models", lambda api_url=None: ["llama3"]), \
                patch.object(models_router, "create_llm_provider", lambda *a, **k: BrokenPoe()):
            resp = client.get("/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body["models"] == [{"name": "llama3", "provider": "ollama"}]
        assert body["unavailable"][0]["provider"] == "poe"
        assert "Poe could not be reached" in body["unavailable"][0]["detail"]
        assert "502 from poe" not in body["unavailable"][0]["detail"]


class TestProvidersRaiseInsteadOfPretending:
    def test_ollama_list_models_raises_when_the_host_is_down(self):
        from kurisuassistant.models.llm.ollama_provider import OllamaProvider

        provider = OllamaProvider(api_url="http://127.0.0.1:9")  # nothing listens on 9
        with pytest.raises(Exception):
            provider.list_models()

    def test_gemini_has_no_fabricated_catalogue(self):
        from kurisuassistant.models.llm import gemini_provider

        source = open(gemini_provider.__file__).read()
        assert "gemini-2.0-flash-lite" not in source
