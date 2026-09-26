"""System tests: keeping a session, and the wire-protocol gate (#311).

The real app on a real Postgres. Every client session depends on
``POST /auth/refresh`` — the desktop's interceptor and Android's authenticator
call it on each 401 — and a wire-protocol mismatch cuts a client off entirely,
so both are driven here through the app rather than through their parsers.
"""

from datetime import timedelta

import pytest
from starlette.websockets import WebSocketDisconnect

from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL
from kurisuassistant.core.security import create_access_token
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.db.session import get_session
from kurisuassistant.version import WIRE_PROTOCOL

pytestmark = pytest.mark.db


def _refresh(client, token):
    return client.post("/auth/refresh", json={"refresh_token": token})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


class TestRefresh:
    def test_a_refresh_token_mints_an_access_token_that_works(self, account):
        resp = _refresh(account.client, account.refresh_token)
        assert resp.status_code == 200, resp.text
        fresh = resp.json()["access_token"]
        assert resp.json()["token_type"] == "bearer"

        me = account.client.get("/users/me", headers=_bearer(fresh))
        assert me.status_code == 200
        assert me.json()["username"] == account.username

    def test_an_access_token_is_not_a_refresh_token(self, account):
        assert _refresh(account.client, account.token).status_code == 401

    def test_a_refresh_token_is_not_an_access_token(self, account):
        assert account.client.get("/users/me", headers=_bearer(account.refresh_token)).status_code == 401

    def test_garbage_and_expired_tokens_are_refused(self, account):
        assert _refresh(account.client, "not-a-token").status_code == 401
        expired = create_access_token({"sub": account.username}, expires_delta=timedelta(seconds=-5))
        assert account.client.get("/users/me", headers=_bearer(expired)).status_code == 401

    def test_a_deactivated_account_cannot_refresh(self, account):
        """Otherwise a refresh token issued while the account worked keeps
        minting access tokens after the operator has taken it back."""
        with get_session() as session:
            UserRepository(session).get_by_username(account.username).is_active = False

        resp = _refresh(account.client, account.refresh_token)
        assert resp.status_code == 403
        assert resp.json()["detail"] == ACCOUNT_INACTIVE_DETAIL

    def test_a_deleted_account_cannot_refresh(self, account):
        from kurisuassistant.db.models import User

        with get_session() as session:
            session.query(User).filter_by(username=account.username).delete()

        assert _refresh(account.client, account.refresh_token).status_code == 401


class TestWireProtocolOverHttp:
    def test_a_mismatched_client_gets_426_with_both_versions(self, account):
        headers = {**_bearer(account.token), "X-Wire-Protocol": str(WIRE_PROTOCOL - 1)}
        resp = account.client.get("/users/me", headers=headers)

        assert resp.status_code == 426
        body = resp.json()
        assert body["detail"] == "wire_protocol_mismatch"
        assert body["client_wire_protocol"] == WIRE_PROTOCOL - 1
        assert body["server_wire_protocol"] == WIRE_PROTOCOL
        assert "backend_version" in body

    def test_a_malformed_version_is_a_mismatch(self, account):
        resp = account.client.get("/users/me", headers={**_bearer(account.token), "X-Wire-Protocol": "seven"})
        assert resp.status_code == 426
        assert resp.json()["client_wire_protocol"] == -1

    def test_the_gate_comes_before_authentication(self, system_client):
        """A stale client is told to update even when its token is no good."""
        resp = system_client.get("/users/me", headers={"X-Wire-Protocol": str(WIRE_PROTOCOL + 1)})
        assert resp.status_code == 426

    @pytest.mark.parametrize("path", ["/health", "/version"])
    def test_the_recovery_routes_answer_a_mismatched_client(self, system_client, path):
        resp = system_client.get(path, headers={"X-Wire-Protocol": str(WIRE_PROTOCOL + 1)})
        assert resp.status_code == 200

    def test_a_matching_or_absent_header_passes(self, account):
        assert account.client.get("/users/me", headers=account.headers).status_code == 200
        assert account.client.get("/users/me", headers=_bearer(account.token)).status_code == 200


class TestWireProtocolOnTheSocket:
    def _close_of(self, client, **kwargs):
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect("/ws/chat", **kwargs) as ws:
                ws.receive_json()
        return excinfo.value

    def test_a_mismatched_header_closes_4426(self, account):
        closed = self._close_of(
            account.client,
            headers={**_bearer(account.token), "X-Wire-Protocol": str(WIRE_PROTOCOL - 1)},
        )
        assert closed.code == 4426
        assert f"server {WIRE_PROTOCOL}" in closed.reason

    def test_a_mismatched_subprotocol_closes_4426(self, account):
        """A browser cannot set headers on a socket; it declares the version as
        a subprotocol entry instead."""
        closed = self._close_of(
            account.client,
            subprotocols=["kurisu.auth.bearer", account.token, f"kurisu.wire.{WIRE_PROTOCOL + 1}"],
        )
        assert closed.code == 4426

    def test_the_socket_gate_comes_before_authentication(self, system_client):
        closed = self._close_of(system_client, headers={"X-Wire-Protocol": str(WIRE_PROTOCOL - 1)})
        assert closed.code == 4426

    def test_no_or_bad_credentials_close_4001(self, system_client):
        assert self._close_of(system_client).code == 4001
        assert self._close_of(system_client, headers=_bearer("not-a-token")).code == 4001

    def test_a_matching_subprotocol_connects(self, account):
        with account.client.websocket_connect(
            "/ws/chat",
            subprotocols=["kurisu.auth.bearer", account.token, f"kurisu.wire.{WIRE_PROTOCOL}"],
        ) as ws:
            assert ws.receive_json()["type"] == "connected"
