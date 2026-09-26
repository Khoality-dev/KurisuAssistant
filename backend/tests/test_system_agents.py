"""System tests: what the assistant does beyond answering (#311).

Sub-agents, skills, a server-side MCP tool, memory written after an idle
conversation, and a conversation compacting itself when it outgrows its window —
each through the real app, a real Postgres and the mock Ollama. Before this,
sub-agents had no test past their tool names, skills a source grep, MCP a
pydantic model, consolidation its bookkeeping, and compaction only its manual
trigger.
"""

import asyncio
import socket
import threading
import time
from datetime import datetime, timedelta

import pytest

from tests.mock_ollama import DEFAULT_MODEL, Reply, ToolCall

pytestmark = pytest.mark.db


def chat_request(text, conversation_id=None):
    return {"type": "chat_request", "text": text, "model_name": DEFAULT_MODEL, "conversation_id": conversation_id}


def turn(account, text, conversation_id=None, limit=400):
    """One turn on a fresh socket; every event up to ``done``/``error``."""
    with account.socket() as ws:
        ws.receive_json()
        ws.send_json(chat_request(text, conversation_id))
        events = []
        for _ in range(limit):
            events.append(ws.receive_json())
            if events[-1]["type"] in ("done", "error"):
                return events
    raise AssertionError(f"no done after {limit} events")


def allow(account, tool):
    resp = account.client.patch("/users/me/tool-policies", json={"tool_name": tool, "policy": "allow"}, headers=account.headers)
    assert resp.status_code == 200, resp.text


def text_of(events):
    return "".join(e.get("content") or "" for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant")


def tool_names(request):
    return {t["function"]["name"] for t in request.get("tools") or []}


def system_text(request):
    return "\n".join(m["content"] for m in request["messages"] if m["role"] == "system")


class TestSubAgents:
    def test_the_assistant_delegates_and_the_sub_agent_answers_with_its_own_prompt(self, account, mock_ollama):
        account.client.post(
            "/sub-agents",
            json={"name": "Researcher", "description": "Looks things up", "system_prompt": "You are a meticulous researcher.",
                  "available_tools": ["drive_read"]},
            headers=account.headers,
        )
        allow(account, "researcher_agent")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall("researcher_agent", {"task": "What is the answer?"})]),
            Reply(content="The answer is 42."),
            Reply(content="My researcher says 42."),
        )

        events = turn(account, "ask the researcher")

        assert events[-1]["type"] == "done"
        assert text_of(events) == "My researcher says 42."
        main_first, sub, main_second = mock_ollama.state.requests_to("/api/chat")
        assert "researcher_agent" in tool_names(main_first)
        assert "You are a meticulous researcher." in system_text(sub)
        assert sub["messages"][-1] == {"role": "user", "content": "What is the answer?"}
        # Built-in tools are every agent's; the allowlist narrows the rest.
        from kurisuassistant.tools.registry import tool_registry

        built_in = {t.name for t in tool_registry._tools.values() if t.built_in}
        assert tool_names(sub) - built_in == {"drive_read"}, "the sub-agent is offered only its own tools"
        assert "drive_write" in tool_names(main_first), "the assistant itself is not narrowed"
        assert [m["content"] for m in main_second["messages"] if m["role"] == "tool"] == ["The answer is 42."]

    def test_a_disabled_sub_agent_is_not_offered(self, account, mock_ollama):
        sub = account.client.post("/sub-agents", json={"name": "Researcher"}, headers=account.headers).json()
        account.client.patch(f"/sub-agents/{sub['id']}/enabled", json={"enabled": False}, headers=account.headers)

        turn(account, "hello")

        assert "researcher_agent" not in tool_names(mock_ollama.state.requests_to("/api/chat")[0])


class TestSkills:
    def test_a_skill_is_named_in_the_prompt_and_its_instructions_reach_the_model(self, account, mock_ollama):
        account.client.post("/skills", json={"name": "Haiku", "instructions": "Write five, seven, five."}, headers=account.headers)
        allow(account, "get_skill_instructions")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall("get_skill_instructions", {"name": "Haiku"})]),
            Reply(content="Autumn moonlight..."),
        )

        events = turn(account, "write me a haiku")

        assert events[-1]["type"] == "done"
        first, second = mock_ollama.state.requests_to("/api/chat")
        assert "Haiku" in system_text(first)
        assert [m["content"] for m in second["messages"] if m["role"] == "tool"] == ["Write five, seven, five."]

    def test_another_accounts_skill_is_not_found(self, account, mock_ollama):
        from tests.conftest import Account, _create_activated_user, _set_ollama_url

        _create_activated_user("skill-owner-" + account.username, "pw")
        owner = Account(account.client, "skill-owner-" + account.username, "pw")
        owner.client.post("/skills", json={"name": "Secret", "instructions": "classified"}, headers=owner.headers)
        allow(account, "get_skill_instructions")
        mock_ollama.state.script(Reply(tool_calls=[ToolCall("get_skill_instructions", {"name": "Secret"})]), Reply(content="None."))

        turn(account, "use the secret skill")

        first, second = mock_ollama.state.requests_to("/api/chat")
        assert "Secret" not in system_text(first)
        assert [m["content"] for m in second["messages"] if m["role"] == "tool"] == ["Skill 'Secret' not found."]


@pytest.fixture()
def mcp_server():
    """A real MCP server over SSE on a free port, with one tool: ``add``."""
    import uvicorn
    from fastmcp import FastMCP

    mcp = FastMCP("mock-tools")

    @mcp.tool
    def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(mcp.http_app(transport="sse"), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        assert time.time() < deadline and thread.is_alive(), "the MCP server did not start"
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}/sse"
    server.should_exit = True
    thread.join(timeout=5)


class TestServerSideMcp:
    def test_a_tool_on_an_sse_server_is_listed_and_runs_in_a_turn(self, account, mock_ollama, mcp_server):
        created = account.client.post(
            "/mcp-servers", json={"name": "maths", "transport_type": "sse", "url": mcp_server}, headers=account.headers,
        )
        assert created.status_code == 200, created.text

        listed = account.client.get("/tools", headers=account.headers).json()
        assert "add" in {t["function"]["name"] for t in listed["mcp_tools"]}
        assert "add" in {t["function"]["name"] for t in listed["mcp_servers"]["maths"]}

        allow(account, "add")
        mock_ollama.state.script(Reply(tool_calls=[ToolCall("add", {"a": 2, "b": 3})]), Reply(content="It is 5."))
        events = turn(account, "what is 2 + 3?")

        assert events[-1]["type"] == "done"
        first, second = mock_ollama.state.requests_to("/api/chat")
        assert "add" in tool_names(first)
        assert [m["content"] for m in second["messages"] if m["role"] == "tool"] == ["5"]

    def test_a_disabled_server_offers_nothing(self, account, mock_ollama, mcp_server):
        server = account.client.post(
            "/mcp-servers", json={"name": "maths", "transport_type": "sse", "url": mcp_server}, headers=account.headers,
        ).json()
        account.client.patch(f"/mcp-servers/{server['id']}", json={"enabled": False}, headers=account.headers)

        assert account.client.get("/tools", headers=account.headers).json()["mcp_tools"] == []
        turn(account, "hello")
        assert "add" not in tool_names(mock_ollama.state.requests_to("/api/chat")[0])


class TestMemory:
    def test_an_idle_conversation_is_consolidated_and_the_next_chat_remembers(self, account, mock_ollama):
        from kurisuassistant.db.models import Conversation
        from kurisuassistant.db.session import get_session
        from kurisuassistant.workers.service import CONVERSATION_IDLE_THRESHOLD_MINUTES, BackgroundService

        account.client.patch("/users/me", json={"summary_model": DEFAULT_MODEL}, headers=account.headers)
        account.client.patch("/assistant", json={"memory_enabled": True}, headers=account.headers)
        conversation_id = turn(account, "I love green tea.")[-1]["conversation_id"]

        # Idle, as if the user walked away: the scan looks at updated_at.
        with get_session() as session:
            session.get(Conversation, conversation_id).updated_at = (
                datetime.utcnow() - timedelta(minutes=CONVERSATION_IDLE_THRESHOLD_MINUTES + 5)
            )

        service = BackgroundService()
        tasks = []
        service.submit = tasks.append  # type: ignore[method-assign]
        service._scan_idle_conversations()
        mine = [t for t in tasks if t.conversation_id == conversation_id]
        assert len(mine) == 1, "the idle conversation is picked up once"
        assert mine[0].api_url == mock_ollama.url, "with the account's own Ollama and summary model"

        mock_ollama.state.script(Reply(content="The user loves green tea."))
        asyncio.run(service._handle_consolidate(mine[0]))

        memory = account.client.get("/assistant", headers=account.headers).json()["memory"]
        assert memory == "The user loves green tea."
        consolidation = mock_ollama.state.requests_to("/api/chat")[-1]
        assert "I love green tea." in consolidation["messages"][-1]["content"], "the transcript is what it summarised"
        with get_session() as session:
            assert session.get(Conversation, conversation_id).consolidated_at is not None

        turn(account, "what do I like?")
        assert "The user loves green tea." in system_text(mock_ollama.state.requests_to("/api/chat")[-1])

        service.submit = tasks.append  # type: ignore[method-assign]
        tasks.clear()
        service._scan_idle_conversations()
        assert conversation_id not in {t.conversation_id for t in tasks}, "a consolidated conversation is not redone"


class TestAutomaticCompaction:
    def test_a_conversation_near_its_window_is_summarised_in_place(self, account, mock_ollama):
        account.client.patch("/users/me", json={"summary_model": DEFAULT_MODEL, "context_size": 2048}, headers=account.headers)
        long_message = "tea " * 2000  # ~8000 characters: well past 90% of a 2048-token window
        mock_ollama.state.script(Reply(content="Noted."))
        first = turn(account, long_message)
        conversation_id = first[-1]["conversation_id"]

        mock_ollama.state.script(
            Reply(content="SUMMARY: the user talked about tea at length."),
            Reply(content="Short answer."),
        )
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("and now?", conversation_id))
            events = []
            while not events or events[-1]["type"] not in ("done", "error"):
                events.append(ws.receive_json())

        infos = [e for e in events if e["type"] == "context_info"]
        assert [i["compacting"] for i in infos] == [True, False]
        assert infos[-1]["compacted_context"] == "SUMMARY: the user talked about tea at length."
        assert "conversation_switched" not in {e["type"] for e in events}, "in place, not a new conversation (#99)"
        assert events[-1] == {**events[-1], "type": "done", "conversation_id": conversation_id}
        assert text_of(events) == "Short answer."

        answered = mock_ollama.state.requests_to("/api/chat")[-1]
        sent = "\n".join(m["content"] or "" for m in answered["messages"])
        assert "SUMMARY: the user talked about tea at length." in sent
        assert long_message.strip() not in sent, "the summarised turn is not sent again"
        assert answered["messages"][-1] == {"role": "user", "content": "and now?"}
