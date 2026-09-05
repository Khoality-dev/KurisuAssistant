"""Server-side enforcement of user tool permission policies.

Regression cover for the case where the backend stored `users.tool_policies`
but never consulted it, delegating every decision to whatever client happened
to be attached, and executing the tool outright when no client was attached
at all.

The rule these tests pin down: the stored policy is the server's decision, and
the client's approval answer can only ever narrow it, never widen it.
"""

import pytest

from kurisuassistant.agents.base import AssistantConfig, PersonaConfig, SubAgentConfig, AgentContext
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.tools import ToolRegistry
from kurisuassistant.tools.base import BaseTool


class EchoTool(BaseTool):
    """Minimal tool whose execution is observable via its return value."""

    name = "echo"
    description = "echo"
    built_in = False

    def get_schema(self):
        return {
            "type": "function",
            "function": {"name": "echo", "description": "echo", "parameters": {}},
        }

    async def execute(self, args):
        return "EXECUTED"


class RecordingHandler:
    """Stands in for a connected client, recording whether it was consulted."""

    def __init__(self, approve=True, modified_args=None):
        self.approve = approve
        self.modified_args = modified_args
        self.asked = False
        self.last_request = None

    async def request_tool_approval(self, request):
        self.asked = True
        self.last_request = request
        approve, modified_args = self.approve, self.modified_args

        class Response:
            pass

        response = Response()
        response.approved = approve
        response.modified_args = modified_args
        return response


@pytest.fixture
def agent():
    registry = ToolRegistry()
    registry.register(EchoTool())
    return MainAgent(AssistantConfig(id=1), registry, identity=PersonaConfig(id=1, name="Tester"))


def context(handler=None, policies=None):
    return AgentContext(user_id=1, handler=handler, tool_policies=policies or {})


class TestStoredDeny:
    """A stored deny is final and is decided without the client."""

    async def test_denies_the_call(self, agent):
        result = await agent.execute_tool("echo", {}, context(policies={"echo": "deny"}))
        assert result.status == "denied"
        assert result.content != "EXECUTED"

    async def test_never_asks_the_client(self, agent):
        handler = RecordingHandler(approve=True)
        await agent.execute_tool("echo", {}, context(handler, {"echo": "deny"}))
        assert handler.asked is False

    async def test_client_approval_cannot_widen_it(self, agent):
        """The client says yes; the stored policy still wins."""
        handler = RecordingHandler(approve=True)
        result = await agent.execute_tool("echo", {}, context(handler, {"echo": "deny"}))
        assert result.status == "denied"
        assert result.content == "Tool execution denied by policy: echo"


class TestStoredAllow:
    """A stored allow is the server pre-approving the call."""

    async def test_executes(self, agent):
        result = await agent.execute_tool("echo", {}, context(policies={"echo": "allow"}))
        assert result.content == "EXECUTED"

    async def test_skips_the_prompt(self, agent):
        handler = RecordingHandler(approve=False)
        result = await agent.execute_tool("echo", {}, context(handler, {"echo": "allow"}))
        assert handler.asked is False
        assert result.content == "EXECUTED"


class TestNoStoredPolicy:
    """Without a policy the client is asked, and its answer is honoured."""

    async def test_asks_the_client(self, agent):
        handler = RecordingHandler(approve=True)
        await agent.execute_tool("echo", {}, context(handler))
        assert handler.asked is True
        assert handler.last_request.tool_name == "echo"

    async def test_client_approval_executes(self, agent):
        handler = RecordingHandler(approve=True)
        result = await agent.execute_tool("echo", {}, context(handler))
        assert result.content == "EXECUTED"

    async def test_client_denial_blocks(self, agent):
        handler = RecordingHandler(approve=False)
        result = await agent.execute_tool("echo", {}, context(handler))
        assert result.status == "denied"
        assert result.content != "EXECUTED"


class TestNoHandler:
    """With nobody to approve, an unapproved call must not run."""

    async def test_denies_instead_of_executing(self, agent):
        result = await agent.execute_tool("echo", {}, context(handler=None))
        assert result.status == "denied"
        assert result.content != "EXECUTED"

    async def test_stored_allow_still_runs_without_a_client(self, agent):
        """The server already decided, so no client is needed."""
        result = await agent.execute_tool("echo", {}, context(None, {"echo": "allow"}))
        assert result.content == "EXECUTED"


class TestPolicyScope:
    """A policy applies to the tool it names and no other."""

    async def test_deny_on_another_tool_does_not_leak(self, agent):
        handler = RecordingHandler(approve=True)
        result = await agent.execute_tool("echo", {}, context(handler, {"other": "deny"}))
        assert handler.asked is True
        assert result.content == "EXECUTED"
