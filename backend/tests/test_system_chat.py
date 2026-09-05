"""System tests: the real app, a real Postgres, the WebSocket, and a mock Ollama.

Everything between the socket and the model is real — ``ChatSessionHandler``,
persona selection, ``MainAgent``, the tool loop and its approval gate, the
provider, the ``ollama`` client — and the model is ``tests/mock_ollama``, so each
turn is deterministic and free.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one). Skips
locally without it, fails on CI.
"""

import pytest

from kurisuassistant.version import WIRE_PROTOCOL
from tests.mock_ollama import DEFAULT_MODEL, Reply, ToolCall

pytestmark = pytest.mark.db

TOOL = "history_list"  # a built-in that needs only the database


@pytest.fixture(scope="module")
def token(system_client):
    resp = system_client.post("/login", data={"username": "admin", "password": "admin"})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "X-Wire-Protocol": str(WIRE_PROTOCOL)}


def set_tool_policy(client, headers, policy):
    resp = client.patch("/users/me/tool-policies", json={"tool_name": TOOL, "policy": policy}, headers=headers)
    assert resp.status_code == 200, resp.text


def events_until_done(ws, limit=200):
    """Read events until ``done`` (or ``error``), returning all of them."""
    out = []
    for _ in range(limit):
        event = ws.receive_json()
        out.append(event)
        if event["type"] in ("done", "error"):
            return out
    raise AssertionError(f"no done/error after {limit} events: {[e['type'] for e in out]}")


def content_of(events):
    return "".join(e.get("content") or "" for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant")


def chat_request(text, conversation_id=None, model=DEFAULT_MODEL):
    return {"type": "chat_request", "text": text, "model_name": model, "conversation_id": conversation_id}


class TestChatTurn:
    def test_a_turn_streams_the_reply_and_completes(self, system_client, headers, mock_ollama):
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            connected = ws.receive_json()
            assert connected["type"] == "connected"

            ws.send_json(chat_request("hello there"))
            events = events_until_done(ws)

        assert events[-1]["type"] == "done"
        assert content_of(events) == "You said: hello there"
        chunks = [e for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant"]
        assert chunks, "the reply streamed"
        assert chunks[0]["persona_name"] == "Assistant", "the seeded default persona answers"
        assert chunks[0]["conversation_id"] == events[-1]["conversation_id"] > 0

        sent = mock_ollama.state.requests_to("/api/chat")
        assert len(sent) == 1
        assert sent[0]["model"] == DEFAULT_MODEL
        assert sent[0]["messages"][0]["role"] == "system"
        assert sent[0]["messages"][-1] == {"role": "user", "content": "hello there"}
        assert sent[0]["options"]["num_ctx"] == 8192
        assert sent[0]["stream"] is True

    def test_thinking_is_streamed_separately_from_content(self, system_client, headers, mock_ollama):
        mock_ollama.state.script(Reply(thinking="Let me think.", content="Forty-two."))
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request("the answer?"))
            events = events_until_done(ws)

        assert content_of(events) == "Forty-two."
        thinking = "".join(e.get("thinking") or "" for e in events if e["type"] == "stream_chunk")
        assert thinking == "Let me think."

    def test_a_second_turn_carries_the_history(self, system_client, headers, mock_ollama):
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request("first"))
            first = events_until_done(ws)
            conversation_id = first[-1]["conversation_id"]
            ws.send_json(chat_request("second", conversation_id=conversation_id))
            second = events_until_done(ws)

        assert second[-1]["conversation_id"] == conversation_id
        history = mock_ollama.state.requests_to("/api/chat")[1]["messages"]
        roles_and_text = [(m["role"], m.get("content")) for m in history if m["role"] != "system"]
        assert roles_and_text == [
            ("user", "first"), ("assistant", "You said: first"), ("user", "second"),
        ]

    def test_an_unknown_model_is_pulled_before_the_turn(self, system_client, headers, mock_ollama):
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request("hi", model="brand-new:3b"))
            events = events_until_done(ws)

        assert events[-1]["type"] == "done"
        assert mock_ollama.state.requests_to("/api/pull")[0]["model"] == "brand-new:3b"
        assert mock_ollama.state.requests_to("/api/chat")[0]["model"] == "brand-new:3b"

    def test_a_provider_error_becomes_an_error_event(self, system_client, headers, mock_ollama):
        mock_ollama.state.script(Reply(status=500, error="the model fell over"))
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request("hi"))
            events = events_until_done(ws)

        assert events[-1]["type"] == "error"
        assert events[-1].get("error")


class TestToolLoop:
    def test_an_allowed_tool_runs_and_its_result_feeds_the_next_turn(self, system_client, headers, mock_ollama):
        set_tool_policy(system_client, headers, "allow")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall(TOOL, {"limit": 3})]),
            Reply(content="Here is what I found."),
        )
        try:
            with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
                ws.receive_json()
                ws.send_json(chat_request("what did we talk about?"))
                events = events_until_done(ws)
        finally:
            set_tool_policy(system_client, headers, None)

        assert events[-1]["type"] == "done"
        assert "tool_approval_request" not in {e["type"] for e in events}, "a stored allow skips the prompt"

        announcing = [e for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant" and e.get("tool_calls")]
        assert announcing[0]["tool_calls"][0]["function"]["name"] == TOOL
        tool_chunks = [e for e in events if e["type"] == "stream_chunk" and e["role"] == "tool"]
        assert tool_chunks[0]["name"] == TOOL
        assert tool_chunks[0]["tool_status"] == "success"
        assert tool_chunks[0]["tool_call_id"] == announcing[0]["tool_calls"][0]["id"]
        assert tool_chunks[0]["persona_id"] is None, "a tool chunk is not the persona speaking"
        assert content_of(events) == "Here is what I found."

        turns = mock_ollama.state.requests_to("/api/chat")
        assert len(turns) == 2
        tool_msgs = [m for m in turns[1]["messages"] if m["role"] == "tool"]
        assert len(tool_msgs) == 1 and tool_msgs[0]["content"]
        # The agent attaches `name` and `tool_call_id` to the tool message, but the
        # ollama client's Message model knows neither and drops both on the wire;
        # only OpenAI-dialect providers see the linkage.
        assert "name" not in tool_msgs[0]

    def test_an_unpoliced_tool_asks_the_client_first(self, system_client, headers, mock_ollama):
        set_tool_policy(system_client, headers, None)
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall(TOOL, {})]),
            Reply(content="Approved and done."),
        )
        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request("list my conversations"))
            event = ws.receive_json()
            while event["type"] != "tool_approval_request":
                assert event["type"] not in ("done", "error"), event
                event = ws.receive_json()
            assert event["tool_name"] == TOOL
            assert event["execution_location"] == "backend"
            ws.send_json({"type": "tool_approval_response", "approval_id": event["approval_id"], "approved": True})
            events = events_until_done(ws)

        assert events[-1]["type"] == "done"
        assert [e["tool_status"] for e in events if e["type"] == "stream_chunk" and e["role"] == "tool"] == ["success"]
        assert content_of(events) == "Approved and done."

    def test_a_denied_tool_never_reaches_the_model_again_as_success(self, system_client, headers, mock_ollama):
        set_tool_policy(system_client, headers, "deny")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall(TOOL, {})]),
            Reply(content="Understood, I cannot do that."),
        )
        try:
            with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
                ws.receive_json()
                ws.send_json(chat_request("list my conversations"))
                events = events_until_done(ws)
        finally:
            set_tool_policy(system_client, headers, None)

        assert "tool_approval_request" not in {e["type"] for e in events}, "a stored deny never asks"
        tool_chunks = [e for e in events if e["type"] == "stream_chunk" and e["role"] == "tool"]
        assert tool_chunks and tool_chunks[0]["tool_status"] == "denied"
        assert events[-1]["type"] in ("done", "error")


class TestCompaction:
    def test_compact_context_summarises_without_streaming_and_forks(self, system_client, headers, mock_ollama):
        resp = system_client.patch("/users/me", json={"summary_model": DEFAULT_MODEL}, headers=headers)
        assert resp.status_code == 200, resp.text
        try:
            with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
                ws.receive_json()
                ws.send_json(chat_request("remember the blue key"))
                first = events_until_done(ws)
                conversation_id = first[-1]["conversation_id"]

                mock_ollama.state.script(Reply(content="Summary: the user has a blue key."))
                ws.send_json({"type": "compact_context", "conversation_id": conversation_id})
                switched = ws.receive_json()
                while switched["type"] != "conversation_switched":
                    assert switched["type"] != "error", switched
                    switched = ws.receive_json()
        finally:
            system_client.patch("/users/me", json={"summary_model": ""}, headers=headers)

        assert switched["old_conversation_id"] == conversation_id
        assert switched["new_conversation_id"] != conversation_id
        assert switched["compacted_context"] == "Summary: the user has a blue key."
        assert switched["persona_id"] > 0, "the persona follows the conversation across the split"

        summary_call = mock_ollama.state.requests_to("/api/chat")[-1]
        assert summary_call["stream"] is False, "compaction uses the non-streaming path"
        assert "blue key" in summary_call["messages"][-1]["content"]

        detail = system_client.get(f"/conversations/{switched['new_conversation_id']}", headers=headers)
        assert detail.status_code == 200
        assert detail.json()["compacted_context"] == "Summary: the user has a blue key."
