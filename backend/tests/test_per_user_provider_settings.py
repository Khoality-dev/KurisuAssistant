"""The Ollama URL and the provider keys come from the account, never the server (#293).

The server used to carry its own ``LLM_API_URL`` and ``*_API_KEY`` values and
fell back to them whenever an account had none, so an account with nothing set
still chatted — through the operator's Ollama, or on the operator's key. Every
check below runs with those old variables set, to prove they are ignored.
"""

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.models.llm import ProviderNotConfigured, create_llm_provider
from kurisuassistant.routers import models as models_router
from kurisuassistant.utils import embeddings as embedding_service


@pytest.fixture()
def server_wide_values(monkeypatch):
    """What an environment file from before #293 still sets."""
    monkeypatch.setenv("LLM_API_URL", "http://server-ollama:11434")
    for name in ("GEMINI_API_KEY", "NVIDIA_API_KEY", "POE_API_KEY"):
        monkeypatch.setenv(name, "server-key")


class TestNoServerFallback:
    @pytest.mark.parametrize("url", [None, ""])
    def test_ollama_needs_the_accounts_url(self, server_wide_values, url):
        with pytest.raises(ProviderNotConfigured, match="Ollama URL"):
            create_llm_provider("ollama", api_url=url)

    @pytest.mark.parametrize("provider,label", [
        ("gemini", "Gemini"), ("nvidia", "NVIDIA"), ("poe", "Poe"),
    ])
    @pytest.mark.parametrize("key", [None, ""])
    def test_a_cloud_provider_needs_the_accounts_key(self, server_wide_values, provider, label, key):
        with pytest.raises(ProviderNotConfigured, match=label):
            create_llm_provider(provider, api_key=key)

    def test_the_message_says_where_to_fix_it(self, server_wide_values):
        with pytest.raises(ProviderNotConfigured) as caught:
            create_llm_provider("poe")
        assert "Account settings" in str(caught.value)

    def test_a_stored_value_is_used_as_given(self, server_wide_values):
        assert create_llm_provider("poe", api_key="user-key").api_key == "user-key"


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


def _must_not_be_called(*args, **kwargs):
    raise AssertionError("a provider the account has not configured was contacted")


class TestModelList:
    def test_an_account_with_nothing_set_lists_nothing_and_contacts_nobody(
        self, client, server_wide_values,
    ):
        with patch.object(models_router, "llm_list_models", _must_not_be_called), \
                patch.object(models_router, "create_llm_provider", _must_not_be_called):
            resp = client.get("/models")
        assert resp.status_code == 200
        assert resp.json() == {"models": [], "unavailable": []}

    def test_the_accounts_own_url_is_the_one_asked(self, client, user):
        user.ollama_url = "http://my-ollama:11434"
        asked = []
        with patch.object(models_router, "llm_list_models",
                          lambda api_url=None: asked.append(api_url) or ["llama3"]):
            resp = client.get("/models")
        assert resp.json()["models"] == [{"name": "llama3", "provider": "ollama"}]
        assert asked == ["http://my-ollama:11434"]

    @pytest.mark.parametrize("method,path", [
        ("get", "/models/details"),
        ("post", "/models/pull"),
        ("delete", "/models/llama3"),
        ("post", "/models/ensure/llama3"),
    ])
    def test_ollama_management_without_a_url_is_a_400_that_says_so(
        self, client, server_wide_values, method, path,
    ):
        kwargs = {"json": {"name": "llama3"}} if path == "/models/pull" else {}
        resp = getattr(client, method)(path, **kwargs)
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "Ollama URL" in detail and "Account settings" in detail
        assert "reference:" not in detail, "a missing setting is not a crash"


class TestEmbeddingsHaveTheirOwnSettings:
    """The shared index is the operator's, so it keeps server-wide settings — its
    own, never the chat ones."""

    @pytest.fixture(autouse=True)
    def _fresh(self):
        embedding_service.reset()
        yield
        embedding_service.reset()

    def test_ollama_embeddings_ignore_the_old_chat_url(self, monkeypatch, server_wide_values):
        monkeypatch.setenv("EMBEDDING_PROVIDER", "ollama")
        monkeypatch.setenv("EMBEDDING_MODEL", "bge-m3")
        monkeypatch.delenv("EMBEDDING_API_URL", raising=False)
        assert not embedding_service.enabled()

    @pytest.mark.parametrize("provider", ["gemini", "nvidia"])
    def test_keyed_embeddings_ignore_the_old_chat_keys(self, monkeypatch, server_wide_values, provider):
        monkeypatch.setenv("EMBEDDING_PROVIDER", provider)
        monkeypatch.setenv("EMBEDDING_MODEL", "some-embedder")
        monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
        assert not embedding_service.enabled()

    def test_the_embedding_url_switches_them_on(self, monkeypatch):
        monkeypatch.setenv("EMBEDDING_PROVIDER", "ollama")
        monkeypatch.setenv("EMBEDDING_MODEL", "bge-m3")
        monkeypatch.setenv("EMBEDDING_API_URL", "http://embedder:11434")
        assert embedding_service.enabled()

    def test_the_embedding_key_switches_keyed_ones_on(self, monkeypatch):
        monkeypatch.setenv("EMBEDDING_PROVIDER", "gemini")
        monkeypatch.setenv("EMBEDDING_MODEL", "gemini-embedding-001")
        monkeypatch.setenv("EMBEDDING_API_KEY", "embed-key")
        assert embedding_service.enabled()
