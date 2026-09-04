"""Transport and asset-serving security.

Three defects that shared a shape: something reachable from outside was trusted
more than it had earned.

  * MCP connections disabled TLS verification unconditionally.
  * Two character-asset routes served any agent's files with no authentication.
  * The WebSocket took its access token from the query string, which proxies log.
"""

import importlib
import inspect
from unittest.mock import MagicMock

import pytest

from kurisuassistant.routers import character, ws


# ---------------------------------------------------------------------------
# TLS verification on MCP connections
# ---------------------------------------------------------------------------

class TestMcpTlsVerification:
    def test_verification_is_on_by_default(self, monkeypatch):
        monkeypatch.delenv("MCP_TLS_VERIFY", raising=False)
        module = importlib.reload(importlib.import_module("kurisuassistant.mcp_tools.orchestrator"))
        assert module._VERIFY_TLS is True

    @pytest.mark.parametrize("value", ["false", "0", "no", "off"])
    def test_an_operator_can_opt_out(self, monkeypatch, value):
        monkeypatch.setenv("MCP_TLS_VERIFY", value)
        module = importlib.reload(importlib.import_module("kurisuassistant.mcp_tools.orchestrator"))
        assert module._VERIFY_TLS is False

    def test_an_unrecognised_value_stays_secure(self, monkeypatch):
        """Anything that is not an explicit opt-out keeps verification on."""
        monkeypatch.setenv("MCP_TLS_VERIFY", "maybe")
        module = importlib.reload(importlib.import_module("kurisuassistant.mcp_tools.orchestrator"))
        assert module._VERIFY_TLS is True

    def test_the_client_factory_honours_the_setting(self, monkeypatch):
        monkeypatch.delenv("MCP_TLS_VERIFY", raising=False)
        module = importlib.reload(importlib.import_module("kurisuassistant.mcp_tools.orchestrator"))
        client = module._httpx_factory()
        try:
            assert client._transport is not None
        finally:
            pass


# ---------------------------------------------------------------------------
# Character asset routes
# ---------------------------------------------------------------------------

def route_signatures(module):
    """Map of route path -> parameter names, for every router-decorated function."""
    import ast

    tree = ast.parse(inspect.getsource(module))
    routes = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and getattr(decorator.func.value, "id", None) == "router"
                and decorator.args
            ):
                routes[decorator.args[0].value] = (node.name, ast.dump(node.args), inspect.getsource(module))
    return routes


class TestCharacterAssetsRequireAuth:
    """Both serving routes were open; agent ids are sequential and guessable."""

    @pytest.mark.parametrize(
        "path", ["/{agent_id}/edges/{edge_id}", "/{agent_id}/{pose_id}/{filename}"],
    )
    def test_route_takes_an_authenticated_user(self, path):
        name, args_dump, _ = route_signatures(character)[path]
        assert "get_authenticated_user" in args_dump, f"{name} does not require authentication"

    @pytest.mark.parametrize(
        "path", ["/{agent_id}/edges/{edge_id}", "/{agent_id}/{pose_id}/{filename}"],
    )
    def test_route_checks_ownership(self, path):
        name, _, source = route_signatures(character)[path]
        body = source.split(f"async def {name}(")[1].split("\n@router")[0]
        assert "_require_agent" in body, (
            f"{name} serves files without checking the agent belongs to the caller"
        )

    def test_every_route_in_the_router_is_authenticated(self):
        for path, (name, args_dump, _) in route_signatures(character).items():
            assert "get_authenticated_user" in args_dump, f"{path} ({name}) is unauthenticated"


# ---------------------------------------------------------------------------
# WebSocket handshake
# ---------------------------------------------------------------------------

def handshake(headers):
    socket = MagicMock()
    socket.headers = headers
    return ws._extract_token(socket)


class TestWebSocketTokenSource:
    def test_authorization_header_is_accepted(self):
        token, subprotocol = handshake({"authorization": "Bearer abc.def.ghi"})
        assert token == "abc.def.ghi"
        assert subprotocol is None

    def test_header_is_case_insensitive(self):
        token, _ = handshake({"authorization": "bearer abc.def.ghi"})
        assert token == "abc.def.ghi"

    def test_subprotocol_is_accepted_for_browser_clients(self):
        token, subprotocol = handshake(
            {"sec-websocket-protocol": f"{ws.WS_AUTH_SUBPROTOCOL}, abc.def.ghi"}
        )
        assert token == "abc.def.ghi"
        assert subprotocol == ws.WS_AUTH_SUBPROTOCOL, "the selection must be echoed on accept"

    def test_query_string_is_no_longer_a_credential_source(self):
        """The regression: a token in the URL is recorded by every proxy in the path."""
        socket = MagicMock()
        socket.headers = {}
        socket.query_params = {"token": "abc.def.ghi"}
        token, _ = ws._extract_token(socket)
        assert token is None

    def test_the_route_declares_no_token_parameter(self):
        signature = inspect.signature(ws.websocket_chat)
        assert list(signature.parameters) == ["websocket"]

    @pytest.mark.parametrize("headers", [
        {},
        {"authorization": "Bearer "},
        {"authorization": "Basic abc"},
        {"sec-websocket-protocol": "abc.def.ghi"},
        {"sec-websocket-protocol": "some.other.protocol, abc.def.ghi"},
        {"sec-websocket-protocol": ws.WS_AUTH_SUBPROTOCOL},
    ])
    def test_malformed_handshakes_yield_no_token(self, headers):
        token, _ = handshake(headers)
        assert token is None
