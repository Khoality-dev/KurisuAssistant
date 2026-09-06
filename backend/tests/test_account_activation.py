"""Registration is open; activation is the gate (#148).

There is no seeded account any more. Anyone may register, nobody gets in until
the operator flips ``users.is_active`` in the database, and the tokens handed out
at registration open nothing until they do.

These run against the real app and a real Postgres, because the property under
test is what the database and three separate authentication paths agree on.
"""

import pytest

from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.db.session import get_session
from kurisuassistant.version import WIRE_PROTOCOL

pytestmark = pytest.mark.db


def _register(client, username, password="a-password"):
    return client.post("/register", data={"username": username, "password": password})


def _activate(username):
    """What the operator does by hand, as SQL would."""
    with get_session() as session:
        UserRepository(session).get_by_username(username).is_active = True


class TestRegistration:
    def test_registering_creates_an_inactive_account_and_says_so(self, system_client):
        resp = _register(system_client, "pending-user")
        assert resp.status_code == 200, resp.text

        body = resp.json()
        assert body["pending_activation"] is True
        assert body["detail"] == ACCOUNT_INACTIVE_DETAIL
        # The token shape an older client expects is still there, so it does not
        # fail to parse the response — the tokens simply open nothing.
        assert body["access_token"] and body["refresh_token"]

        with get_session() as session:
            assert UserRepository(session).get_by_username("pending-user").is_active is False

    def test_registration_is_open(self, system_client):
        """It was closed by default when a seeded admin existed. Activation is
        the gate now, and the only one (#184)."""
        assert _register(system_client, "open-to-anyone").status_code == 200


class TestTheGate:
    def test_login_refuses_an_inactive_account_with_the_reason(self, system_client):
        _register(system_client, "inactive-login", password="pw-inactive")

        resp = system_client.post(
            "/login", data={"username": "inactive-login", "password": "pw-inactive"}
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == ACCOUNT_INACTIVE_DETAIL

    def test_a_registration_token_opens_nothing(self, system_client):
        token = _register(system_client, "inactive-token").json()["access_token"]

        resp = system_client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403
        assert resp.json()["detail"] == ACCOUNT_INACTIVE_DETAIL

    def test_the_chat_socket_refuses_an_inactive_account(self, system_client):
        """The socket authenticates itself, so the gate has to be there too."""
        token = _register(system_client, "inactive-socket").json()["access_token"]

        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as excinfo:
            with system_client.websocket_connect(
                "/ws/chat",
                subprotocols=["kurisu.auth.bearer", token, f"kurisu.wire.{WIRE_PROTOCOL}"],
            ) as ws:
                ws.receive_json()

        # 4001 is the code the clients already treat as "your credentials are no
        # good" — and the reason carries the sentence a user should be shown.
        assert excinfo.value.code == 4001
        assert excinfo.value.reason == ACCOUNT_INACTIVE_DETAIL

    def test_activation_lets_the_same_account_straight_in(self, system_client):
        _register(system_client, "activated-user", password="pw-active")
        _activate("activated-user")

        resp = system_client.post(
            "/login", data={"username": "activated-user", "password": "pw-active"}
        )
        assert resp.status_code == 200, resp.text

        token = resp.json()["access_token"]
        me = system_client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200
        assert me.json()["username"] == "activated-user"

    def test_deactivating_takes_effect_on_the_next_request(self, system_client):
        """The check is per request, not only at login, so access can be taken
        back without waiting for a token to expire."""
        _register(system_client, "revoked-user", password="pw-revoked")
        _activate("revoked-user")
        token = system_client.post(
            "/login", data={"username": "revoked-user", "password": "pw-revoked"}
        ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert system_client.get("/users/me", headers=headers).status_code == 200

        with get_session() as session:
            UserRepository(session).get_by_username("revoked-user").is_active = False

        assert system_client.get("/users/me", headers=headers).status_code == 403


class TestNothingIsSeeded:
    def test_a_migrated_database_has_no_admin_account(self, system_db):
        """The whole point: no published password ships with the server."""
        with get_session() as session:
            assert UserRepository(session).get_by_username("admin") is None
