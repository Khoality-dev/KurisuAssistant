"""Server-side stdio MCP servers must be refused.

A stdio MCP entry names a command for the host to run, and those rows are
user-writable through the MCP API, so accepting one for `location="server"`
was arbitrary command execution inside the API container.

The refusal is deliberately in two independent places, and both are covered
here: the API must not store such a row, and the orchestrator must not start
one that is already stored.
"""

import types

import pytest
from pydantic import ValidationError

from kurisuassistant.mcp_tools.orchestrator import _create_client_from_server
from kurisuassistant.routers.mcp import MCPServerCreate


def row(**overrides):
    """A stand-in for an MCPServer database row."""
    fields = {
        "name": "server",
        "transport_type": "sse",
        "url": None,
        "command": None,
        "args": None,
        "env": None,
    }
    fields.update(overrides)
    return types.SimpleNamespace(**fields)


class TestApiRejectsServerSideStdio:
    def test_explicit_server_location_is_rejected(self):
        with pytest.raises(ValidationError, match="cannot run server-side"):
            MCPServerCreate(
                name="shell",
                transport_type="stdio",
                command="/bin/sh",
                args=["-c", "id"],
                location="server",
            )

    def test_omitted_location_is_rejected(self):
        """location defaults to "server", so leaving it out must not slip through."""
        with pytest.raises(ValidationError, match="cannot run server-side"):
            MCPServerCreate(name="shell", transport_type="stdio", command="/bin/sh")


class TestApiStillAcceptsWhatItShould:
    def test_client_side_stdio_is_allowed(self):
        """stdio belongs to the desktop app, which runs it behind its own prompts."""
        model = MCPServerCreate(
            name="playwright", transport_type="stdio", command="npx", location="client",
        )
        assert model.location == "client"
        assert model.transport_type == "stdio"

    def test_server_side_sse_is_allowed(self):
        model = MCPServerCreate(
            name="remote", transport_type="sse", url="https://example.test/sse",
        )
        assert model.location == "server"

    def test_unknown_transport_is_still_rejected(self):
        with pytest.raises(ValidationError):
            MCPServerCreate(name="odd", transport_type="carrier-pigeon")


class TestOrchestratorRefusesStoredStdio:
    """Rows predating the API check must not start either."""

    def test_stdio_row_builds_no_client(self):
        assert _create_client_from_server(
            row(transport_type="stdio", command="/bin/sh", args=["-c", "id"])
        ) is None

    def test_stdio_row_without_a_command_builds_no_client(self):
        assert _create_client_from_server(row(transport_type="stdio")) is None

    def test_sse_row_still_builds_a_client(self):
        assert _create_client_from_server(
            row(transport_type="sse", url="https://example.test/sse")
        ) is not None

    def test_sse_row_without_a_url_builds_no_client(self):
        assert _create_client_from_server(row(transport_type="sse")) is None
