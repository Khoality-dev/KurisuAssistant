"""The login limiter counts the right caller, and counts them twice (#155).

Behind a reverse proxy the socket peer is the proxy, so keying on it alone gave
the whole world one bucket: ten failures from anyone locked out everyone, and an
attacker got ten attempts shared with legitimate users. Two things fix it — the
forwarded address, believed only when the peer is a trusted proxy, and a second
bucket on the username, which no proxy can rewrite.

`ProxyHeadersMiddleware` here is the same class uvicorn wraps the app in; the
entrypoint decides its `trusted_hosts` from `FORWARDED_ALLOW_IPS`, so these
tests exercise the deployed arrangement rather than a stand-in for it.
"""

import logging
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from kurisuassistant.routers import auth

PROXY = "10.0.0.9"


@pytest.fixture(autouse=True)
def reset_limiter(monkeypatch):
    auth._attempts.clear()
    auth._resolved_client_logged = False
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    yield
    auth._attempts.clear()
    auth._resolved_client_logged = False


@pytest.fixture
def app():
    app = FastAPI()
    app.include_router(auth.router)
    return app


class Failing:
    """Every login attempt is a wrong password."""

    async def execute(self, operation):
        raise HTTPException(status_code=400, detail="Incorrect username or password")


def client_from(app, address, *, behind_proxy=False):
    """A TestClient whose requests arrive from `address` — directly, or through
    a proxy at PROXY that the app is configured to trust."""
    if behind_proxy:
        return TestClient(ProxyHeadersMiddleware(app, trusted_hosts=PROXY), client=(PROXY, 0))
    return TestClient(app, client=(address, 0))


def login(client, username="alice", *, forwarded_for=None):
    headers = {"X-Forwarded-For": forwarded_for} if forwarded_for else None
    return client.post(
        "/login", data={"username": username, "password": "wrong"}, headers=headers,
    )


class TestPerAddressBucket:
    def test_two_addresses_do_not_share_a_budget(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 0)
        with patch.object(auth, "get_db_service", lambda: Failing()):
            first = client_from(app, "198.51.100.1")
            second = client_from(app, "198.51.100.2")
            assert [login(first).status_code for _ in range(2)] == [400, 400]
            assert login(first).status_code == 429
            # The second address has spent nothing.
            assert login(second).status_code == 400

    def test_behind_a_trusted_proxy_the_forwarded_address_is_counted(self, app, monkeypatch):
        """The fix: two people behind one proxy get one budget each, not one
        budget between them."""
        monkeypatch.setenv("FORWARDED_ALLOW_IPS", PROXY)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 0)
        proxied = client_from(app, PROXY, behind_proxy=True)

        with patch.object(auth, "get_db_service", lambda: Failing()):
            attacker = [login(proxied, forwarded_for="203.0.113.7").status_code for _ in range(3)]
            victim = login(proxied, forwarded_for="203.0.113.8")

        assert attacker == [400, 400, 429]
        assert victim.status_code == 400, "one caller's failures locked out another behind the same proxy"

    def test_an_untrusted_peer_cannot_choose_its_own_bucket(self, app, monkeypatch):
        """Without FORWARDED_ALLOW_IPS the header is ignored, so a direct caller
        cannot mint a fresh budget by varying it."""
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 2)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 0)
        direct = client_from(app, "198.51.100.5")

        with patch.object(auth, "get_db_service", lambda: Failing()):
            codes = [
                login(direct, forwarded_for=f"203.0.113.{n}").status_code for n in range(1, 4)
            ]
        assert codes == [400, 400, 429]

    def test_an_ignored_forwarded_header_is_reported_once(self, app, monkeypatch, caplog):
        """The misconfiguration to catch: a proxy is in front, nothing trusts it."""
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 5)
        direct = client_from(app, "198.51.100.5")
        with caplog.at_level(logging.WARNING, logger=auth.__name__):
            with patch.object(auth, "get_db_service", lambda: Failing()):
                login(direct, forwarded_for="203.0.113.7")
                login(direct, forwarded_for="203.0.113.7")

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert len(warnings) == 1, "said it more than once, or not at all"
        assert "FORWARDED_ALLOW_IPS" in warnings[0].getMessage()

    def test_the_resolved_address_is_reported_when_a_proxy_is_trusted(self, app, monkeypatch, caplog):
        monkeypatch.setenv("FORWARDED_ALLOW_IPS", PROXY)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 5)
        proxied = client_from(app, PROXY, behind_proxy=True)
        with caplog.at_level(logging.INFO, logger=auth.__name__):
            with patch.object(auth, "get_db_service", lambda: Failing()):
                login(proxied, forwarded_for="203.0.113.7")
        assert "203.0.113.7" in caplog.text


class TestPerUsernameBucket:
    def test_one_account_is_bounded_across_many_addresses(self, app, monkeypatch):
        """What survives a botnet, and a shared address: the username."""
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 3)
        with patch.object(auth, "get_db_service", lambda: Failing()):
            codes = [
                login(client_from(app, f"198.51.100.{n}"), "alice").status_code
                for n in range(1, 6)
            ]
        assert codes == [400, 400, 400, 429, 429]

    def test_other_accounts_are_unaffected(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 2)
        one = client_from(app, "198.51.100.1")
        with patch.object(auth, "get_db_service", lambda: Failing()):
            assert [login(one, "alice").status_code for _ in range(3)] == [400, 400, 429]
            assert login(one, "bob").status_code == 400

    def test_spelling_the_username_differently_buys_nothing(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 2)
        one = client_from(app, "198.51.100.1")
        with patch.object(auth, "get_db_service", lambda: Failing()):
            codes = [login(one, name).status_code for name in ("alice", "Alice", " ALICE ")]
        assert codes == [400, 400, 429]

    def test_it_can_be_disabled(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 0)
        one = client_from(app, "198.51.100.1")
        with patch.object(auth, "get_db_service", lambda: Failing()):
            codes = [login(one, "alice").status_code for _ in range(25)]
        assert set(codes) == {400}

    def test_a_successful_login_clears_both_buckets(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 3)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 3)
        one = client_from(app, "198.51.100.1")

        class Succeeding:
            async def execute(self, operation):
                return "alice"

        with patch.object(auth, "get_db_service", lambda: Failing()):
            assert [login(one, "alice").status_code for _ in range(2)] == [400, 400]
        with patch.object(auth, "get_db_service", lambda: Succeeding()):
            assert login(one, "alice").status_code == 200
        assert auth._attempts == {}

    def test_a_refused_request_does_not_charge_the_other_bucket(self, app, monkeypatch):
        """Over budget on the address, the username's budget must be untouched —
        otherwise one blocked caller drains the account's allowance too."""
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 1)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 5)
        blocked = client_from(app, "198.51.100.1")
        with patch.object(auth, "get_db_service", lambda: Failing()):
            assert login(blocked, "alice").status_code == 400
            for _ in range(4):
                assert login(blocked, "alice").status_code == 429
        assert len(auth._attempts[auth._username_key("login", "alice")]) == 1


class TestTheRefusalSaysNothingExtra:
    def test_both_buckets_answer_identically(self, app, monkeypatch):
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 1)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 0)
        with patch.object(auth, "get_db_service", lambda: Failing()):
            one = client_from(app, "198.51.100.1")
            login(one, "alice")
            by_address = login(one, "alice")

        auth._attempts.clear()
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS", 0)
        monkeypatch.setattr(auth, "_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", 1)
        with patch.object(auth, "get_db_service", lambda: Failing()):
            two = client_from(app, "198.51.100.2")
            login(two, "alice")
            by_username = login(two, "alice")

        assert by_address.status_code == by_username.status_code == 429
        assert by_address.json() == by_username.json()
        assert "Retry-After" in by_address.headers and "Retry-After" in by_username.headers
