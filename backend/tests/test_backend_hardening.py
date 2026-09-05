"""Five small backend defects, each invisible until the wrong input arrives.

- deferred `call_tool` recursing into itself with no depth guard
- image uploads read whole into memory with no ceiling
- the MCP orchestrator rebuilding every client on a thirty-second timer
- a signing key written relative to the working directory
- the tool-round cap ending a turn in silence, and colliding sub-agent tool names
"""

import io
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from kurisuassistant.agents.base import AssistantConfig, PersonaConfig, SubAgentConfig, AgentContext
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.agents.sub import SubAgent, SubAgentTool
from kurisuassistant.tools import ToolRegistry


def agent():
    return MainAgent(AssistantConfig(id=1), ToolRegistry(), identity=PersonaConfig(id=1, name="Tester"))


# ---------------------------------------------------------------------------
# Deferred call_tool
# ---------------------------------------------------------------------------

class TestCallToolDepthGuard:
    async def test_call_tool_cannot_name_itself(self):
        ctx = AgentContext(user_id=1, tool_policies={"call_tool": "allow"})
        result = await agent().execute_tool(
            "call_tool", {"name": "call_tool", "arguments": {}}, ctx,
        )
        assert result.status == "error"
        assert "cannot invoke call_tool" in result.content

    async def test_a_missing_inner_name_is_refused(self):
        ctx = AgentContext(user_id=1, tool_policies={"call_tool": "allow"})
        result = await agent().execute_tool("call_tool", {"arguments": {}}, ctx)
        assert result.status == "error"
        assert "requires a tool name" in result.content

    async def test_unparseable_arguments_are_refused(self):
        ctx = AgentContext(user_id=1, tool_policies={"call_tool": "allow"})
        result = await agent().execute_tool(
            "call_tool", {"name": "echo", "arguments": "{not json"}, ctx,
        )
        assert result.status == "error"
        assert "valid JSON" in result.content

    async def test_non_object_arguments_are_refused(self):
        ctx = AgentContext(user_id=1, tool_policies={"call_tool": "allow"})
        result = await agent().execute_tool(
            "call_tool", {"name": "echo", "arguments": "[1, 2, 3]"}, ctx,
        )
        assert result.status == "error"
        assert "must be an object" in result.content

    async def test_one_level_of_indirection_still_works(self):
        """The guard must not break the protocol it protects."""
        ctx = AgentContext(user_id=1, handler=None, tool_policies={"echo": "allow"})
        a = agent()
        with patch.object(a, "_execute_mcp_tool", new_callable=AsyncMock) as mcp:
            mcp.return_value = MagicMock(content="ok", status="success")
            await a.execute_tool("call_tool", {"name": "echo", "arguments": {}}, ctx)
        assert mcp.await_count == 1


# ---------------------------------------------------------------------------
# Image size ceiling
# ---------------------------------------------------------------------------

class TestImageSizeLimit:
    def test_an_oversized_upload_is_refused(self):
        from kurisuassistant.utils import images

        upload = MagicMock()
        upload.file = io.BytesIO(b"\x00" * (images.MAX_IMAGE_BYTES + 1024))

        with pytest.raises(HTTPException) as exc:
            images.upload_image(upload)
        assert exc.value.status_code == 413

    def test_the_read_is_bounded_rather_than_truncating(self):
        from kurisuassistant.utils.images import _read_bounded

        with pytest.raises(HTTPException):
            _read_bounded(io.BytesIO(b"x" * 101), limit=100)

        assert _read_bounded(io.BytesIO(b"x" * 100), limit=100) == b"x" * 100

    def test_a_missing_content_type_does_not_crash(self):
        """content_type was assumed non-null, so its absence raised a 500."""
        from kurisuassistant.utils import images

        upload = MagicMock()
        upload.content_type = None
        upload.file = io.BytesIO(b"not really an image")

        with pytest.raises(HTTPException) as exc:
            images.upload_image(upload)
        assert exc.value.status_code == 400

    def test_base64_images_are_bounded_too(self):
        """These arrive over the socket, so they need the same ceiling."""
        from kurisuassistant.utils.images import MAX_IMAGE_BYTES, save_image_from_base64

        oversized = "A" * ((MAX_IMAGE_BYTES * 4) // 3 + 100)
        with pytest.raises(ValueError, match="maximum allowed size"):
            save_image_from_base64(oversized, user_id=1)


# ---------------------------------------------------------------------------
# MCP client reuse
# ---------------------------------------------------------------------------

def orchestrator_with(rows):
    from kurisuassistant.mcp_tools.orchestrator import UserMCPOrchestrator

    orchestrator = UserMCPOrchestrator(user_id=1)
    db = MagicMock()
    db.execute_sync = MagicMock(return_value=rows)
    return orchestrator, db


SSE_ROW = ("remote", "sse", "https://example.test/sse", None, None, None)


class TestOrchestratorReusesClients:
    def test_an_unchanged_server_keeps_its_client(self):
        orchestrator, db = orchestrator_with([SSE_ROW])
        with patch("kurisuassistant.db.service.get_db_service", lambda: db):
            orchestrator._load_servers()
            first = orchestrator._server_clients["remote"]
            orchestrator._load_servers()
            second = orchestrator._server_clients["remote"]

        assert first is second, "a refresh must not rebuild an unchanged server"

    def test_a_changed_server_is_rebuilt(self):
        orchestrator, db = orchestrator_with([SSE_ROW])
        with patch("kurisuassistant.db.service.get_db_service", lambda: db):
            orchestrator._load_servers()
            first = orchestrator._server_clients["remote"]

            db.execute_sync.return_value = [
                ("remote", "sse", "https://elsewhere.test/sse", None, None, None)
            ]
            orchestrator._load_servers()
            second = orchestrator._server_clients["remote"]

        assert first is not second

    def test_a_removed_server_is_dropped(self):
        orchestrator, db = orchestrator_with([SSE_ROW])
        with patch("kurisuassistant.db.service.get_db_service", lambda: db):
            orchestrator._load_servers()
            db.execute_sync.return_value = []
            orchestrator._load_servers()

        assert orchestrator._server_clients == {}
        assert orchestrator._server_configs == {}


# ---------------------------------------------------------------------------
# Signing key location
# ---------------------------------------------------------------------------

class TestSigningKeyLocation:
    def test_the_key_path_does_not_depend_on_the_working_directory(self):
        """A cwd-relative path minted a new key when started from elsewhere,
        invalidating every issued token."""
        import inspect

        from kurisuassistant.core import security

        source = inspect.getsource(security._load_or_create_secret)
        assert 'Path("data/jwt_secret.key")' not in source
        assert "DATA_DIR" in source

    def test_it_resolves_under_the_package_data_directory(self):
        from kurisuassistant.core.paths import DATA_DIR

        assert DATA_DIR.is_absolute()


# ---------------------------------------------------------------------------
# Tool-round cap and sub-agent naming
# ---------------------------------------------------------------------------

class TestSubAgentToolNames:
    def test_distinct_names_are_unchanged(self):
        taken: set = set()
        assert SubAgentTool._to_tool_name("Web Search", taken) == "web_search_agent"
        assert SubAgentTool._to_tool_name("Planner", taken) == "planner_agent"

    def test_colliding_names_are_disambiguated(self):
        """"Web Search" and "web-search" both collapse to the same tool name."""
        taken: set = set()
        first = SubAgentTool._to_tool_name("Web Search", taken)
        second = SubAgentTool._to_tool_name("web-search", taken)
        third = SubAgentTool._to_tool_name("WEB_SEARCH", taken)

        assert len({first, second, third}) == 3
        assert second.startswith("web_search_agent")

    def test_adapters_built_together_get_unique_names(self):
        registry = ToolRegistry()
        taken: set = set()
        names = [
            SubAgentTool(SubAgent(SubAgentConfig(id=i, name=n), registry), taken).name
            for i, n in enumerate(["Web Search", "web-search"])
        ]
        assert len(set(names)) == 2


class TestToolRoundCapIsAnnounced:
    async def test_the_user_is_told_the_turn_was_truncated(self):
        """The stream used to just stop, indistinguishable from a finished answer."""
        from kurisuassistant.agents import main as main_module

        class FakeMessage:
            def __init__(self):
                self.content = ""
                self.thinking = None
                self.tool_calls = [
                    type("TC", (), {"function": type("F", (), {"name": "echo", "arguments": {}})()})()
                ]

        class FakeChunk:
            def __init__(self):
                self.message = FakeMessage()

        class Provider:
            def chat(self, **kwargs):
                return iter([FakeChunk()])  # always asks for another tool

        a = agent()
        ctx = AgentContext(user_id=1, conversation_id=1, tool_policies={"echo": "allow"})

        with patch("kurisuassistant.models.llm.create_llm_provider", return_value=Provider()), \
             patch.object(MainAgent, "execute_tool", new_callable=AsyncMock) as mock_exec, \
             patch.object(main_module, "MAX_TOOL_ROUNDS", 2, create=True):
            mock_exec.return_value = MagicMock(content="ok", status="success", images=[])
            chunks = [c async for c in a.process([{"role": "user", "content": "go"}], ctx)]

        text = "".join(c.content for c in chunks if c.role == "assistant")
        assert "Stopped after" in text and "tool calls" in text
