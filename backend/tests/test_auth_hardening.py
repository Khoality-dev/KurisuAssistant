"""Account creation is closed by default, guessing is rate limited, and
provider API keys are never read back.

Cover for the three halves of the same problem: anyone who could reach the
server could create an account, guess a password without limit, and read the
account's third-party API keys straight out of the profile endpoint.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.routers import auth, users


# ---------------------------------------------------------------------------
# Registration gate + rate limiting
# ---------------------------------------------------------------------------

class FakeDBService:
    """Runs the submitted operation against a stub session."""

    def __init__(self, result=None):
        self.result = result
        self.calls = 0

    async def execute(self, operation):
        self.calls += 1
        return self.result if self.result is not None else operation(MagicMock())


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    auth._attempts.clear()
    yield
    auth._attempts.clear()


@pytest.fixture
def auth_client():
    app = FastAPI()
    app.include_router(auth.router)
    return TestClient(app)


def credentials(username="newuser", password="hunter2"):
    return {"username": username, "password": password}


class TestRegistrationIsClosedByDefault:
    def test_rejected_when_unset(self, auth_client, monkeypatch):
        monkeypatch.delenv("ALLOW_REGISTRATION", raising=False)
        response = auth_client.post("/register", data=credentials())
        assert response.status_code == 403
        assert "closed" in response.json()["detail"].lower()

    @pytest.mark.parametrize("value", ["false", "0", "no", "off", "", "maybe"])
    def test_rejected_for_non_affirmative_values(self, auth_client, monkeypatch, value):
        monkeypatch.setenv("ALLOW_REGISTRATION", value)
        assert auth_client.post("/register", data=credentials()).status_code == 403

    def test_no_account_is_created_while_closed(self, auth_client, monkeypatch):
        """The refusal must happen before anything touches the database."""
        monkeypatch.delenv("ALLOW_REGISTRATION", raising=False)
        db = FakeDBService(result="newuser")
        with patch.object(auth, "get_db_service", lambda: db):
            auth_client.post("/register", data=credentials())
        assert db.calls == 0


class TestRegistrationCanBeOpened:
    @pytest.mark.parametrize("value", ["true", "1", "yes", "on", "TRUE", " True "])
    def test_allowed_for_affirmative_values(self, auth_client, monkeypatch, value):
        monkeypatch.setenv("ALLOW_REGISTRATION", value)
        db = FakeDBService(result="newuser")
        with patch.object(auth, "get_db_service", lambda: db):
            response = auth_client.post("/register", data=credentials())
        assert response.status_code == 200
        assert "access_token" in response.json()


class TestRateLimiting:
    def test_repeated_failures_are_eventually_refused(self, auth_client, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 3)

        class Failing:
            async def execute(self, operation):
                from fastapi import HTTPException
                raise HTTPException(status_code=400, detail="Incorrect username or password")

        with patch.object(auth, "get_db_service", lambda: Failing()):
            first = [auth_client.post("/login", data=credentials()).status_code for _ in range(3)]
            blocked = auth_client.post("/login", data=credentials())

        assert first == [400, 400, 400]
        assert blocked.status_code == 429
        assert "Retry-After" in blocked.headers

    def test_a_successful_login_clears_the_count(self, auth_client, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 2)
        db = FakeDBService(result="alice")
        with patch.object(auth, "get_db_service", lambda: db):
            assert auth_client.post("/login", data=credentials()).status_code == 200
            assert auth_client.post("/login", data=credentials()).status_code == 200
            assert auth_client.post("/login", data=credentials()).status_code == 200

    def test_limit_can_be_disabled(self, auth_client, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)

        class Failing:
            async def execute(self, operation):
                from fastapi import HTTPException
                raise HTTPException(status_code=400, detail="nope")

        with patch.object(auth, "get_db_service", lambda: Failing()):
            codes = [auth_client.post("/login", data=credentials()).status_code for _ in range(20)]
        assert set(codes) == {400}


# ---------------------------------------------------------------------------
# Provider keys are write-only
# ---------------------------------------------------------------------------

class FakeUser:
    def __init__(self, gemini=None, nvidia=None, poe=None):
        self.id = 1
        self.username = "alice"
        self.system_prompt = ""
        self.preferred_name = ""
        self.agent_avatar_uuid = None
        self.ollama_url = None
        self.gemini_api_key = gemini
        self.nvidia_api_key = nvidia
        self.poe_api_key = poe
        self.summary_model = None
        self.summary_provider = "ollama"
        self.context_size = None
        self.tool_policies = None


def profile_client(user):
    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = lambda: user
    app.include_router(users.router)
    return TestClient(app)


class TestProfileNeverReturnsKeys:
    def test_key_values_are_absent(self):
        secret = "AIzaSy-super-secret-value"
        body = profile_client(FakeUser(gemini=secret, nvidia="nvapi-secret", poe="poe-secret")).get("/users/me").json()
        assert "gemini_api_key" not in body
        assert "nvidia_api_key" not in body
        assert "poe_api_key" not in body
        assert secret not in str(body)
        assert "nvapi-secret" not in str(body)
        assert "poe-secret" not in str(body)

    def test_presence_is_reported_when_set(self):
        body = profile_client(FakeUser(gemini="k", nvidia="k", poe="k")).get("/users/me").json()
        assert body["has_gemini_key"] is True
        assert body["has_nvidia_key"] is True
        assert body["has_poe_key"] is True

    def test_presence_is_reported_when_unset(self):
        body = profile_client(FakeUser()).get("/users/me").json()
        assert body["has_gemini_key"] is False
        assert body["has_nvidia_key"] is False
        assert body["has_poe_key"] is False

    def test_an_empty_string_counts_as_unset(self):
        body = profile_client(FakeUser(gemini="", nvidia="")).get("/users/me").json()
        assert body["has_gemini_key"] is False

    def test_other_profile_fields_still_returned(self):
        body = profile_client(FakeUser()).get("/users/me").json()
        for field in ("username", "system_prompt", "ollama_url", "summary_model", "context_size"):
            assert field in body
