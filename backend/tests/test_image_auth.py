"""The image router must verify its token rather than assume an account.

Regression cover for a hardcoded `username = "admin"` that ignored the token
entirely, so any non-empty token value was served the admin account's private
per-user images.

`GET /images/u/{uuid}` accepts the token as a query parameter because an
`<img src=...>` tag cannot send an Authorization header. That is where the token
arrives outside the usual dependency, so it needs its own cover.

The verification itself now lives in `core/deps.resolve_user_from_token`, shared
with the drive's download route (#17) so the two cannot drift; these tests still
drive it through `images._get_user_from_token`, which is what a caller uses, and
patch the module that actually reaches the database.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from kurisuassistant.core import deps
from kurisuassistant.core.security import create_access_token, create_refresh_token
from kurisuassistant.routers import images


class FakeUser:
    def __init__(self, username, is_active=True):
        self.id = hash(username) % 1000
        self.username = username
        # This router resolves the caller itself, so it carries its own copy of
        # the activation gate (#148) and the stub has to model it.
        self.is_active = is_active


class FakeUserRepository:
    """Records the username the router looked up."""

    # Usernames this fake should report as not yet activated.
    inactive_usernames: set = set()

    looked_up = []

    def __init__(self, session):
        pass

    def get_by_username(self, username):
        FakeUserRepository.looked_up.append(username)
        if username == "ghost":
            return None
        return FakeUser(username, is_active=username not in self.inactive_usernames)


@pytest.fixture
def fake_db():
    """Patch the DB service the resolver uses, so it runs against a stub session."""
    FakeUserRepository.looked_up = []

    class FakeDBService:
        async def execute(self, operation):
            return operation(MagicMock())

    with patch.object(deps, "get_db_service", lambda: FakeDBService()), \
         patch.object(deps, "UserRepository", FakeUserRepository):
        yield


class TestRejectsBadTokens:
    """Nothing that fails verification may resolve to an account."""

    @pytest.mark.parametrize(
        "token", [None, "", "not-a-jwt", "Bearer nonsense", "a.b.c"],
    )
    async def test_rejected_with_401(self, token, fake_db):
        with pytest.raises(HTTPException) as exc:
            await images._get_user_from_token(token)
        assert exc.value.status_code == 401

    async def test_never_reaches_the_database(self, fake_db):
        """A bad token must be refused before any account is looked up."""
        with pytest.raises(HTTPException):
            await images._get_user_from_token("not-a-jwt")
        assert FakeUserRepository.looked_up == []

    async def test_refresh_token_is_not_accepted_as_an_access_token(self, fake_db):
        with pytest.raises(HTTPException) as exc:
            await images._get_user_from_token(create_refresh_token({"sub": "alice"}))
        assert exc.value.status_code == 401


class TestActivationGate:
    """This router resolves its own caller, so `get_authenticated_user`'s
    activation gate never sees these calls (#148). A hole here would be
    trusted."""

    async def test_an_inactive_account_is_refused(self, fake_db, monkeypatch):
        monkeypatch.setattr(FakeUserRepository, "inactive_usernames", {"dormant"})
        with pytest.raises(HTTPException) as exc:
            await images._get_user_from_token(create_access_token({"sub": "dormant"}))
        assert exc.value.status_code == 403
        assert "activated" in exc.value.detail.lower()

    async def test_an_activated_account_still_resolves(self, fake_db):
        user = await images._get_user_from_token(create_access_token({"sub": "alice"}))
        assert user.username == "alice"


class TestResolvesTheTokenHolder:
    """A valid token resolves to its own subject, not a fixed account."""

    async def test_returns_the_user_named_by_the_token(self, fake_db):
        user = await images._get_user_from_token(create_access_token({"sub": "alice"}))
        assert user.username == "alice"

    async def test_does_not_fall_back_to_admin(self, fake_db):
        """The original defect resolved every caller to admin."""
        user = await images._get_user_from_token(create_access_token({"sub": "bob"}))
        assert user.username == "bob"
        assert FakeUserRepository.looked_up == ["bob"]

    async def test_two_tokens_resolve_to_different_users(self, fake_db):
        alice = await images._get_user_from_token(create_access_token({"sub": "alice"}))
        bob = await images._get_user_from_token(create_access_token({"sub": "bob"}))
        assert alice.username != bob.username

    async def test_valid_token_for_a_deleted_account_is_rejected(self, fake_db):
        with pytest.raises(HTTPException) as exc:
            await images._get_user_from_token(create_access_token({"sub": "ghost"}))
        assert exc.value.status_code == 401
