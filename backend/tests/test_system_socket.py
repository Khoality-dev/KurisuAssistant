"""System tests: the chat socket beyond a plain turn (#311).

The real ``ChatSessionHandler`` over a real socket, a real Postgres and the mock
Ollama. What the desktop's host tools and client MCP depend on — a tool the
*client* runs for the assistant — and what a user does mid-reply — stop it, keep
typing, reconnect — were only ever driven against an ``AsyncMock`` socket.
"""

import base64
import io

import pytest

from tests.mock_ollama import DEFAULT_MODEL, Reply, ToolCall

pytestmark = pytest.mark.db

CLIENT_TOOL = "host_echo"
CLIENT_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": CLIENT_TOOL,
        "description": "Echo text back from the client.",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
}
SLOW = " ".join(f"word{i}" for i in range(60))


def chat_request(text, conversation_id=None, **extra):
    return {"type": "chat_request", "text": text, "model_name": DEFAULT_MODEL, "conversation_id": conversation_id, **extra}


def read_until(ws, *types, limit=300):
    """Events up to and including the first of ``types``."""
    out = []
    for _ in range(limit):
        event = ws.receive_json()
        out.append(event)
        if event["type"] in types:
            return out
    raise AssertionError(f"no {types} after {limit} events: {[e['type'] for e in out]}")


def assistant_text(events):
    return "".join(e.get("content") or "" for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant")


def set_policy(account, tool, policy):
    resp = account.client.patch("/users/me/tool-policies", json={"tool_name": tool, "policy": policy}, headers=account.headers)
    assert resp.status_code == 200, resp.text


def offered_tools(request):
    return {t["function"]["name"] for t in request.get("tools") or []}


class TestClientTools:
    def test_a_tool_the_client_registered_runs_on_the_client(self, account, mock_ollama):
        set_policy(account, CLIENT_TOOL, "allow")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall(CLIENT_TOOL, {"text": "ping"})]),
            Reply(content="The client said pong."),
        )
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json({"type": "client_tools_register", "tools": [CLIENT_TOOL_SCHEMA]})
            ws.send_json(chat_request("echo ping"))
            request = read_until(ws, "tool_call_request", "done", "error")[-1]
            assert request["type"] == "tool_call_request"
            assert request["tool_name"] == CLIENT_TOOL
            assert request["tool_args"] == {"text": "ping"}
            ws.send_json({"type": "tool_call_response", "request_id": request["request_id"], "content": "pong"})
            events = read_until(ws, "done", "error")

        assert events[-1]["type"] == "done"
        assert assistant_text(events) == "The client said pong."
        turns = mock_ollama.state.requests_to("/api/chat")
        assert CLIENT_TOOL in offered_tools(turns[0]), "the registered tool is offered to the model"
        assert [m["content"] for m in turns[1]["messages"] if m["role"] == "tool"] == ["pong"]

    def test_an_unpoliced_client_tool_is_approved_before_it_is_sent(self, account, mock_ollama):
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall(CLIENT_TOOL, {"text": "hi"})]),
            Reply(content="Done."),
        )
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json({"type": "client_tools_register", "tools": [CLIENT_TOOL_SCHEMA]})
            ws.send_json(chat_request("echo hi"))
            approval = read_until(ws, "tool_approval_request", "tool_call_request", "done", "error")[-1]
            assert approval["type"] == "tool_approval_request", "nothing runs on the client before a person agrees"
            assert approval["execution_location"] == "frontend"
            ws.send_json({"type": "tool_approval_response", "approval_id": approval["approval_id"], "approved": True})
            request = read_until(ws, "tool_call_request", "done", "error")[-1]
            assert request["type"] == "tool_call_request"
            ws.send_json({"type": "tool_call_response", "request_id": request["request_id"], "content": "hi"})
            assert read_until(ws, "done", "error")[-1]["type"] == "done"

    def test_a_denied_client_tool_never_reaches_the_client(self, account, mock_ollama):
        set_policy(account, CLIENT_TOOL, "deny")
        mock_ollama.state.script(Reply(tool_calls=[ToolCall(CLIENT_TOOL, {"text": "x"})]), Reply(content="Cannot."))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json({"type": "client_tools_register", "tools": [CLIENT_TOOL_SCHEMA]})
            ws.send_json(chat_request("echo x"))
            events = read_until(ws, "done", "error")

        types = {e["type"] for e in events}
        assert "tool_call_request" not in types and "tool_approval_request" not in types
        assert [e["tool_status"] for e in events if e["type"] == "stream_chunk" and e["role"] == "tool"] == ["denied"]

    def test_a_client_error_reaches_the_model_as_an_error(self, account, mock_ollama):
        set_policy(account, CLIENT_TOOL, "allow")
        mock_ollama.state.script(Reply(tool_calls=[ToolCall(CLIENT_TOOL, {"text": "x"})]), Reply(content="It failed."))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json({"type": "client_tools_register", "tools": [CLIENT_TOOL_SCHEMA]})
            ws.send_json(chat_request("echo x"))
            request = read_until(ws, "tool_call_request")[-1]
            ws.send_json({"type": "tool_call_response", "request_id": request["request_id"], "content": "disk full", "is_error": True})
            assert read_until(ws, "done", "error")[-1]["type"] == "done"

        tool_message = [m for m in mock_ollama.state.requests_to("/api/chat")[1]["messages"] if m["role"] == "tool"][0]
        assert tool_message["content"] == "Client tool error: disk full"

    def test_a_new_socket_drops_the_previous_clients_tools(self, account, mock_ollama):
        """Otherwise the model is offered tools the new client cannot run, and
        each call to one stalls the turn for the full two-minute timeout."""
        with account.socket() as first:
            first.receive_json()
            first.send_json({"type": "client_tools_register", "tools": [CLIENT_TOOL_SCHEMA]})
            first.send_json(chat_request("with tools"))
            read_until(first, "done")
            with account.socket() as second:
                second.receive_json()
                second.send_json(chat_request("without them"))
                read_until(second, "done")

        with_tools, without = mock_ollama.state.requests_to("/api/chat")
        assert CLIENT_TOOL in offered_tools(with_tools)
        assert CLIENT_TOOL not in offered_tools(without)


class TestMidReply:
    def test_stop_ends_the_turn_and_the_next_one_runs(self, account, mock_ollama):
        mock_ollama.state.script(Reply(content=SLOW, delay_ms=40), Reply(content="Fresh answer."))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("talk for a while"))
            first = read_until(ws, "stream_chunk")[-1]
            conversation_id = first["conversation_id"]
            ws.send_json({"type": "cancel"})
            ws.send_json(chat_request("something else", conversation_id=conversation_id))
            events = read_until(ws, "done", "error")

        assert events[-1]["type"] == "done"
        assert events[-1]["conversation_id"] == conversation_id
        assert assistant_text(events).endswith("Fresh answer.")
        assert SLOW not in assistant_text(events), "the stopped reply did not run to the end"

        stored = account.client.get(f"/conversations/{conversation_id}", headers=account.headers).json()["messages"]
        users = [m["content"] for m in stored if m["role"] == "user"]
        assert users == ["talk for a while", "something else"], "each message is stored once, in order"
        assert all(m["content"] or m.get("thinking") or m.get("tool_calls") for m in stored), "no empty message is stored"

    def test_messages_sent_during_a_reply_run_as_one_turn_after_it(self, account, mock_ollama):
        mock_ollama.state.script(Reply(content="first answer " * 10, delay_ms=30), Reply(content="Both answered."))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("first"))
            conversation_id = read_until(ws, "stream_chunk")[-1]["conversation_id"]
            ws.send_json(chat_request("second", conversation_id=conversation_id))
            ws.send_json(chat_request("third", conversation_id=conversation_id))
            first_done = read_until(ws, "done", "error")
            second_done = read_until(ws, "done", "error")

        assert first_done[-1]["type"] == second_done[-1]["type"] == "done"
        assert assistant_text(second_done) == "Both answered."
        turns = mock_ollama.state.requests_to("/api/chat")
        assert len(turns) == 2, "the two queued messages are one follow-up turn"
        tail = [(m["role"], m["content"]) for m in turns[1]["messages"][-2:]]
        assert tail == [("user", "second"), ("user", "third")]

    def test_a_full_queue_refuses_the_next_message(self, account, mock_ollama):
        from kurisuassistant.websocket.handlers import MAX_QUEUED_MESSAGES

        mock_ollama.state.script(Reply(content=SLOW, delay_ms=50))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("long one"))
            conversation_id = read_until(ws, "stream_chunk")[-1]["conversation_id"]
            for i in range(MAX_QUEUED_MESSAGES + 1):
                ws.send_json(chat_request(f"queued {i}", conversation_id=conversation_id))
            error = read_until(ws, "error")[-1]
            ws.send_json({"type": "cancel"})

        assert error["code"] == "QUEUE_FULL"

    def test_a_reconnect_mid_reply_gets_the_rest_of_it(self, account, mock_ollama):
        mock_ollama.state.script(Reply(content="one two three four five six seven eight", delay_ms=60))
        with account.socket() as first:
            first.receive_json()
            first.send_json(chat_request("count"))
            conversation_id = read_until(first, "stream_chunk")[-1]["conversation_id"]
            with account.socket() as second:
                connected = second.receive_json()
                assert connected["type"] == "connected"
                assert connected["chat_active"] is True
                assert connected["conversation_id"] == conversation_id
                rest = read_until(second, "done", "error")

        assert rest[-1] == {**rest[-1], "type": "done", "conversation_id": conversation_id}
        assert assistant_text(rest).strip().endswith("eight")


class TestImages:
    def test_an_image_sent_with_a_message_reaches_the_model_and_the_history(self, account, mock_ollama):
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), (200, 30, 30)).save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode()

        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("what is this?", images=[encoded]))
            events = read_until(ws, "done", "error")
        assert events[-1]["type"] == "done"

        user_turn = mock_ollama.state.requests_to("/api/chat")[0]["messages"][-1]
        assert user_turn["role"] == "user"
        assert len(user_turn.get("images") or []) == 1, "the model is shown the image"

        stored = account.client.get(f"/conversations/{events[-1]['conversation_id']}", headers=account.headers).json()["messages"]
        image_ids = stored[0].get("images") or []
        assert len(image_ids) == 1
        served = account.client.get(f"/images/u/{image_ids[0]}", params={"token": account.token})
        assert served.status_code == 200
        assert served.headers["content-type"].startswith("image/")
