"""Tool calls and their results must stay linked across persistence.

Within one turn the agent loop already produced a correct sequence. The problem
was the next turn: nothing stored the assistant's ``tool_calls`` or the id of
the call each ``tool`` message answered, so replayed history was a tool result
with no request in front of it.

Ollama accepts that shape, which is why it went unnoticed. OpenAI-compatible
endpoints, which the NVIDIA provider speaks, reject it — so the failure only
appears once someone switches an agent's provider, on the second turn of any
conversation that used a tool.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.agents.base import AssistantConfig, PersonaConfig, SubAgentConfig, AgentContext
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.tools import ToolRegistry


def validate_openai_shape(messages):
    """Return the problems an OpenAI-compatible endpoint would reject.

    Two rules matter here: a tool message must carry a tool_call_id, and that id
    must belong to a call announced by an earlier assistant message.
    """
    announced = set()
    problems = []
    for i, m in enumerate(messages):
        if m.get("role") == "assistant":
            for call in m.get("tool_calls") or []:
                if call.get("id"):
                    announced.add(call["id"])
        elif m.get("role") == "tool":
            call_id = m.get("tool_call_id")
            if not call_id:
                problems.append(f"message {i}: tool result with no tool_call_id")
            elif call_id not in announced:
                problems.append(f"message {i}: tool_call_id {call_id!r} answers no announced call")
    return problems


def agent():
    return MainAgent(AssistantConfig(id=1), ToolRegistry(), identity=PersonaConfig(id=1, name="Tester"))


def context():
    return AgentContext(user_id=1, conversation_id=7, model_name="test-model")


# ---------------------------------------------------------------------------
# The validator itself — a test that cannot fail is worth nothing
# ---------------------------------------------------------------------------

class TestValidator:
    def test_flags_an_orphaned_tool_result(self):
        problems = validate_openai_shape([
            {"role": "user", "content": "hi"},
            {"role": "tool", "content": "42"},
        ])
        assert problems

    def test_flags_a_mismatched_id(self):
        problems = validate_openai_shape([
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_a", "function": {}}]},
            {"role": "tool", "content": "42", "tool_call_id": "call_b"},
        ])
        assert problems

    def test_accepts_a_linked_pair(self):
        assert not validate_openai_shape([
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_a", "function": {}}]},
            {"role": "tool", "content": "42", "tool_call_id": "call_a"},
        ])


# ---------------------------------------------------------------------------
# Replay out of the database
# ---------------------------------------------------------------------------

def stored_history():
    """History in the shape _load_context_messages returns it."""
    return [
        {"role": "user", "content": "what is the weather"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_abc123",
                "type": "function",
                "function": {"name": "get_weather", "arguments": {"city": "Hanoi"}},
            }],
        },
        {"role": "tool", "content": "31C and humid", "tool_call_id": "call_abc123", "name": "get_weather"},
        {"role": "assistant", "content": "It is 31C and humid."},
        {"role": "user", "content": "and tomorrow?"},
    ]


class TestPreparedHistoryKeepsTheLinkage:
    async def test_assistant_tool_calls_survive(self):
        prepared = await agent()._prepare_messages(stored_history(), context())
        assistant = [m for m in prepared if m["role"] == "assistant" and m.get("tool_calls")]
        assert len(assistant) == 1
        assert assistant[0]["tool_calls"][0]["id"] == "call_abc123"

    async def test_tool_result_keeps_its_call_id(self):
        prepared = await agent()._prepare_messages(stored_history(), context())
        tool_messages = [m for m in prepared if m["role"] == "tool"]
        assert len(tool_messages) == 1
        assert tool_messages[0]["tool_call_id"] == "call_abc123"
        assert tool_messages[0]["name"] == "get_weather"

    async def test_replayed_history_is_valid_for_strict_providers(self):
        """The regression itself: this list used to contain an orphaned tool result."""
        prepared = await agent()._prepare_messages(stored_history(), context())
        assert validate_openai_shape(prepared) == []

    async def test_history_without_linkage_still_loads(self):
        """Messages stored before the linkage existed must not break the prompt."""
        legacy = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        prepared = await agent()._prepare_messages(legacy, context())
        assert [m["role"] for m in prepared] == ["system", "user", "assistant"]


# ---------------------------------------------------------------------------
# The agent loop emits the linkage in the first place
# ---------------------------------------------------------------------------

class FakeFunction:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class FakeToolCall:
    """A provider tool call. Ollama supplies no id; this mimics that."""

    def __init__(self, name, arguments):
        self.function = FakeFunction(name, arguments)


class FakeMessage:
    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.thinking = None
        self.tool_calls = tool_calls or []


class FakeChunk:
    def __init__(self, message):
        self.message = message


def fake_provider(turns):
    """A provider whose successive chat() calls yield the given chunk lists."""
    calls = iter(turns)

    class Provider:
        def chat(self, **kwargs):
            return iter(next(calls))

    return Provider()


class TestAgentEmitsLinkage:
    async def _run(self):
        turns = [
            [FakeChunk(FakeMessage(tool_calls=[FakeToolCall("get_weather", {"city": "Hanoi"})]))],
            [FakeChunk(FakeMessage(content="It is 31C."))],
        ]
        a = agent()
        ctx = context()
        ctx.handler = None
        ctx.tool_policies = {"get_weather": "allow"}

        with patch("kurisuassistant.models.llm.create_llm_provider", return_value=fake_provider(turns)), \
             patch.object(MainAgent, "execute_tool", new_callable=AsyncMock) as mock_exec:
            mock_exec.return_value = MagicMock(content="31C and humid", status="success", images=[])
            return [c async for c in a.process([{"role": "user", "content": "weather?"}], ctx)]

    async def test_an_assistant_chunk_announces_the_calls(self):
        chunks = await self._run()
        announcing = [c for c in chunks if c.role == "assistant" and c.tool_calls]
        assert len(announcing) == 1
        call = announcing[0].tool_calls[0]
        assert call["function"]["name"] == "get_weather"
        assert call["id"], "every call needs an id, including from providers that omit one"

    async def test_the_tool_chunk_points_back_at_its_call(self):
        chunks = await self._run()
        announced = [c for c in chunks if c.role == "assistant" and c.tool_calls][0].tool_calls[0]["id"]
        tool_chunks = [c for c in chunks if c.role == "tool"]
        assert len(tool_chunks) == 1
        assert tool_chunks[0].tool_call_id == announced

    async def test_generated_ids_are_unique_per_call(self):
        turns = [
            [FakeChunk(FakeMessage(tool_calls=[
                FakeToolCall("get_weather", {"city": "Hanoi"}),
                FakeToolCall("get_weather", {"city": "Hue"}),
            ]))],
            [FakeChunk(FakeMessage(content="done"))],
        ]
        a = agent()
        ctx = context()
        ctx.handler = None
        ctx.tool_policies = {"get_weather": "allow"}

        with patch("kurisuassistant.models.llm.create_llm_provider", return_value=fake_provider(turns)), \
             patch.object(MainAgent, "execute_tool", new_callable=AsyncMock) as mock_exec:
            mock_exec.return_value = MagicMock(content="ok", status="success", images=[])
            chunks = [c async for c in a.process([{"role": "user", "content": "weather?"}], ctx)]

        ids = [c["id"] for c in [x for x in chunks if x.role == "assistant" and x.tool_calls][0].tool_calls]
        assert len(ids) == len(set(ids)) == 2
