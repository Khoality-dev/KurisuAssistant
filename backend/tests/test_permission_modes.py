"""The account's permission mode is the whole of tool permission (#360).

Every tool is always offered to the model; nothing switches one off. What the
mode decides is what happens when the assistant calls one:

- ``ask`` (the default): every call waits for a human, reads included;
- ``read_only``: a tool that only looks runs without asking, anything else is
  refused without reaching the client;
- ``full``: everything runs without asking.

A tool only looks when it says so: ``BaseTool.read_only`` for the server's own,
``read_only`` on a client's registration, the ``readOnlyHint`` annotation on an
MCP tool. A tool that does not say counts as one that changes something.
"""

import pytest

from kurisuassistant.agents.base import AgentContext, AssistantConfig, PersonaConfig
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.agents.permissions import PERMISSION_MODES, decide
from kurisuassistant.tools import ToolRegistry, tool_registry
from kurisuassistant.tools.base import BaseTool


class ChangeTool(BaseTool):
    name = "change"
    description = "changes something"

    def get_schema(self):
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": {}}}

    async def execute(self, args):
        return "EXECUTED"


class LookTool(ChangeTool):
    name = "look"
    description = "only looks"
    read_only = True


class RecordingHandler:
    """A connected client, recording whether it was asked."""

    def __init__(self, approve=True):
        self.approve = approve
        self.asked = False

    async def request_tool_approval(self, request):
        self.asked = True

        class Response:
            approved = self.approve
            modified_args = None

        return Response()


@pytest.fixture
def agent():
    registry = ToolRegistry()
    registry.register(ChangeTool())
    registry.register(LookTool())
    return MainAgent(AssistantConfig(id=1), registry, identity=PersonaConfig(id=1, name="Tester"))


def context(mode, handler=None, **kw):
    return AgentContext(user_id=0, handler=handler, permission_mode=mode, **kw)


class TestDecide:
    @pytest.mark.parametrize("mode,read_only,expected", [
        ("ask", True, "ask"),
        ("ask", False, "ask"),
        ("read_only", True, "run"),
        ("read_only", False, "refuse"),
        ("full", True, "run"),
        ("full", False, "run"),
    ])
    def test_the_table(self, mode, read_only, expected):
        assert decide(mode, read_only) == expected

    def test_an_unknown_mode_asks(self):
        """Anything the server does not recognise fails safe."""
        assert decide("auto", False) == "ask"
        assert decide("", True) == "ask"

    def test_auto_is_not_a_mode_yet(self):
        assert PERMISSION_MODES == ("ask", "read_only", "full")


class TestAlwaysAsk:
    async def test_a_read_waits_for_the_user(self, agent):
        handler = RecordingHandler()
        result = await agent.execute_tool("look", {}, context("ask", handler))
        assert handler.asked is True
        assert result.content == "EXECUTED"

    async def test_a_denial_blocks(self, agent):
        result = await agent.execute_tool("change", {}, context("ask", RecordingHandler(approve=False)))
        assert result.status == "denied"

    async def test_nobody_to_ask_means_refused(self, agent):
        result = await agent.execute_tool("look", {}, context("ask"))
        assert result.status == "denied"


class TestReadOnly:
    async def test_a_read_runs_without_asking(self, agent):
        handler = RecordingHandler(approve=False)
        result = await agent.execute_tool("look", {}, context("read_only", handler))
        assert handler.asked is False
        assert result.content == "EXECUTED"

    async def test_a_change_is_refused_without_reaching_the_client(self, agent):
        handler = RecordingHandler(approve=True)
        result = await agent.execute_tool("change", {}, context("read_only", handler))
        assert handler.asked is False
        assert result.status == "denied"
        assert "Read only" in result.content

    async def test_a_client_tool_that_does_not_say_is_a_change(self, agent):
        calls = []

        async def callback(name, args):
            calls.append(name)
            return "RAN ON CLIENT"

        tools = [{"type": "function", "function": {"name": "host_bash", "description": "", "parameters": {}}}]
        result = await agent.execute_tool(
            "host_bash", {}, context("read_only", RecordingHandler(), client_tools=tools, client_tool_callback=callback),
        )
        assert result.status == "denied"
        assert calls == []

    async def test_a_client_tool_registered_read_only_runs(self, agent):
        async def callback(name, args):
            return "RAN ON CLIENT"

        tools = [{"type": "function", "function": {"name": "host_read", "description": "", "parameters": {}}}]
        result = await agent.execute_tool(
            "host_read", {},
            context("read_only", RecordingHandler(approve=False), client_tools=tools,
                    client_read_only_tools={"host_read"}, client_tool_callback=callback),
        )
        assert result.content == "RAN ON CLIENT"


class TestFullAccess:
    async def test_everything_runs_without_asking(self, agent):
        handler = RecordingHandler(approve=False)
        for name in ("look", "change"):
            result = await agent.execute_tool(name, {}, context("full", handler))
            assert result.content == "EXECUTED"
        assert handler.asked is False

    async def test_it_needs_no_client(self, agent):
        result = await agent.execute_tool("change", {}, context("full"))
        assert result.content == "EXECUTED"


class TestEveryToolIsOffered:
    def test_the_registry_has_no_filter(self):
        names = {s["function"]["name"] for s in tool_registry.get_schemas()}
        assert {"drive_write", "drive_delete", "calendar_create", "history_list"} <= names

    def test_nothing_is_built_in_any_more(self):
        assert not hasattr(BaseTool, "built_in")

    def test_the_assistant_has_no_tool_list(self):
        assert not hasattr(AssistantConfig(), "available_tools")


class TestWhichToolsOnlyLook:
    READS = {
        "history_list", "history_read", "recall_regex", "recall_semantic",
        "get_skill_instructions", "notify_user", "drive_list", "drive_read",
        "calendar_list", "task_list",
    }
    CHANGES = {
        "drive_write", "drive_delete", "calendar_create", "calendar_move",
        "calendar_delete", "task_start", "task_schedule", "task_update",
        "task_stop", "task_delete",
    }

    def test_reads(self):
        for name in self.READS:
            assert tool_registry.get(name).read_only is True, name

    def test_changes(self):
        for name in self.CHANGES:
            assert tool_registry.get(name).read_only is False, name

    def test_a_tool_changes_something_unless_it_says_otherwise(self):
        assert BaseTool.read_only is False


class TestNotifications:
    """notify_user only reaches the user's own devices, and a background task
    with nobody attached must be able to say it is done — so it never waits,
    in any mode."""

    @pytest.mark.parametrize("mode", PERMISSION_MODES)
    async def test_it_runs_in_every_mode(self, mode):
        tool = tool_registry.get("notify_user")
        assert tool.allowed_by_default is True
        registry = ToolRegistry()

        class Quiet(LookTool):
            name = "quiet"
            allowed_by_default = True

        registry.register(Quiet())
        agent = MainAgent(AssistantConfig(id=1), registry, identity=PersonaConfig(id=1, name="Tester"))
        handler = RecordingHandler(approve=False)
        result = await agent.execute_tool("quiet", {}, context(mode, handler))
        assert handler.asked is False
        assert result.content == "EXECUTED"


class TestMcpReadOnlyHint:
    async def test_the_hint_is_read_from_the_annotations(self):
        from types import SimpleNamespace

        from kurisuassistant.mcp_tools.client import list_tools

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def list_tools(self):
                return [
                    SimpleNamespace(name="get_weather", description="", inputSchema={},
                                    annotations=SimpleNamespace(readOnlyHint=True)),
                    SimpleNamespace(name="set_light", description="", inputSchema={},
                                    annotations=SimpleNamespace(readOnlyHint=False)),
                    SimpleNamespace(name="mystery", description="", inputSchema={}, annotations=None),
                ]

        tools = await list_tools(FakeClient())
        assert {t["function"]["name"]: t["read_only"] for t in tools} == {
            "get_weather": True, "set_light": False, "mystery": False,
        }
