"""Unit tests for users router tool policies endpoints."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import MagicMock, AsyncMock, patch

from kurisuassistant.core.deps import get_authenticated_user, get_db
from kurisuassistant.routers import users


class FakeUser:
    """Fake user for testing."""

    def __init__(self, id=1, username="testuser", tool_policies=None):
        self.id = id
        self.username = username
        self.tool_policies = tool_policies


@pytest.fixture
def fake_user():
    """Default fake user with empty policies."""
    return FakeUser()


@pytest.fixture
def app(fake_user):
    """FastAPI app with users router and auth bypassed."""
    app = FastAPI()
    app.dependency_overrides[get_authenticated_user] = lambda: fake_user
    app.dependency_overrides[get_db] = lambda: MagicMock()
    app.include_router(users.router)
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /users/me/tool-policies
# ---------------------------------------------------------------------------

class TestGetToolPolicies:
    def test_returns_empty_tools_when_no_policies(self, client, fake_user):
        """New user with no policies returns empty tools dict."""
        fake_user.tool_policies = None
        response = client.get("/users/me/tool-policies")
        assert response.status_code == 200
        assert response.json() == {"tools": {}}

    def test_returns_existing_policies(self, client, fake_user):
        """User with existing policies returns them."""
        fake_user.tool_policies = {"tools": {"web_search": "allow", "bash": "deny"}}
        response = client.get("/users/me/tool-policies")
        assert response.status_code == 200
        assert response.json() == {
            "tools": {"web_search": "allow", "bash": "deny"}
        }


# ---------------------------------------------------------------------------
# PUT /users/me/tool-policies
# ---------------------------------------------------------------------------

class TestPutToolPolicies:
    @patch("kurisuassistant.routers.users.get_db_service")
    def test_replaces_all_policies(self, mock_get_db, client, fake_user):
        """PUT replaces entire policies object."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        fake_user.tool_policies = {"tools": {"old_tool": "allow"}}

        response = client.put(
            "/users/me/tool-policies",
            json={"tools": {"new_tool": "deny"}}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

        # Verify db.execute was called
        mock_db.execute.assert_called_once()

    @patch("kurisuassistant.routers.users.get_db_service")
    def test_validates_policy_values(self, mock_get_db, client, fake_user):
        """PUT rejects invalid policy values."""
        response = client.put(
            "/users/me/tool-policies",
            json={"tools": {"web_search": "invalid"}}
        )
        assert response.status_code == 400
        assert "must be 'allow' or 'deny'" in response.json()["detail"]

    @patch("kurisuassistant.routers.users.get_db_service")
    def test_clears_all_policies(self, mock_get_db, client, fake_user):
        """PUT with empty tools clears all policies."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        fake_user.tool_policies = {"tools": {"web_search": "allow"}}

        response = client.put(
            "/users/me/tool-policies",
            json={"tools": {}}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# PATCH /users/me/tool-policies
# ---------------------------------------------------------------------------

class TestPatchToolPolicy:
    @patch("kurisuassistant.routers.users.get_db_service")
    def test_adds_new_policy(self, mock_get_db, client, fake_user):
        """PATCH adds a policy for a new tool."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        fake_user.tool_policies = None

        response = client.patch(
            "/users/me/tool-policies",
            json={"tool_name": "web_search", "policy": "allow"}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    @patch("kurisuassistant.routers.users.get_db_service")
    def test_updates_existing_policy(self, mock_get_db, client, fake_user):
        """PATCH updates an existing tool's policy."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        fake_user.tool_policies = {"tools": {"web_search": "allow"}}

        response = client.patch(
            "/users/me/tool-policies",
            json={"tool_name": "web_search", "policy": "deny"}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    @patch("kurisuassistant.routers.users.get_db_service")
    def test_removes_policy_with_null(self, mock_get_db, client, fake_user):
        """PATCH with null policy removes the tool's policy."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        fake_user.tool_policies = {"tools": {"web_search": "allow"}}

        response = client.patch(
            "/users/me/tool-policies",
            json={"tool_name": "web_search", "policy": None}
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_rejects_missing_tool_name(self, client, fake_user):
        """PATCH without tool_name returns 400."""
        response = client.patch(
            "/users/me/tool-policies",
            json={"policy": "allow"}
        )
        assert response.status_code == 400
        assert "tool_name is required" in response.json()["detail"]

    def test_rejects_invalid_policy(self, client, fake_user):
        """PATCH with invalid policy value returns 400."""
        response = client.patch(
            "/users/me/tool-policies",
            json={"tool_name": "web_search", "policy": "invalid"}
        )
        assert response.status_code == 400
        assert "must be 'allow', 'deny', or null" in response.json()["detail"]

    @patch("kurisuassistant.routers.users.get_db_service")
    def test_allow_and_deny_values_accepted(self, mock_get_db, client, fake_user):
        """PATCH accepts 'allow' and 'deny' values."""
        mock_db = MagicMock()
        mock_db.execute = AsyncMock()
        mock_get_db.return_value = mock_db

        for policy in ["allow", "deny"]:
            response = client.patch(
                "/users/me/tool-policies",
                json={"tool_name": "test_tool", "policy": policy}
            )
            assert response.status_code == 200
