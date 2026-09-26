"""System tests: the settings routes, through the real app and database (#311).

Deleting conversations and messages, tool policies, the model routes against the
mock Ollama, sub-agents, MCP servers, skills and a persona's export and import —
each was tested against a MagicMock database, a pydantic model or a source grep,
or not at all. Every test has an account of its own (``account``), and the ones
about ownership make a second.
"""

import io
import json

import pytest

from tests.conftest import Account, _create_activated_user, _set_ollama_url
from tests.mock_ollama import DEFAULT_MODEL, Reply, ToolCall

pytestmark = pytest.mark.db


def chat_request(text, conversation_id=None):
    return {"type": "chat_request", "text": text, "model_name": DEFAULT_MODEL, "conversation_id": conversation_id}


def run_turn(account, text, conversation_id=None, limit=300):
    with account.socket() as ws:
        ws.receive_json()
        ws.send_json(chat_request(text, conversation_id))
        for _ in range(limit):
            event = ws.receive_json()
            if event["type"] in ("done", "error"):
                return event
    raise AssertionError("the turn never finished")


@pytest.fixture()
def other(system_client, mock_ollama):
    """A second account, for what must stay out of the first one's reach."""
    import uuid

    username = f"other-{uuid.uuid4().hex[:10]}"
    _create_activated_user(username, "other-password")
    _set_ollama_url(username, mock_ollama.url)
    return Account(system_client, username, "other-password")


class TestDeleting:
    def test_deleting_a_conversation_takes_its_messages(self, account, other):
        done = run_turn(account, "remember this")
        mine = done["conversation_id"]
        theirs = run_turn(other, "and this")["conversation_id"]
        messages = account.client.get(f"/conversations/{mine}", headers=account.headers).json()["messages"]

        assert account.client.delete(f"/conversations/{theirs}", headers=account.headers).status_code == 404
        assert account.client.delete(f"/conversations/{mine}", headers=account.headers).status_code == 200

        assert account.client.get(f"/conversations/{mine}", headers=account.headers).status_code == 404
        for message in messages:
            assert account.client.get(f"/messages/{message['id']}", headers=account.headers).status_code == 404
        assert other.client.get(f"/conversations/{theirs}", headers=other.headers).status_code == 200

    def test_deleting_a_message_takes_everything_after_it(self, account, other):
        conversation_id = run_turn(account, "one")["conversation_id"]
        run_turn(account, "two", conversation_id)
        stored = account.client.get(f"/conversations/{conversation_id}", headers=account.headers).json()["messages"]
        assert [m["content"] for m in stored if m["role"] == "user"] == ["one", "two"]
        second_user = [m for m in stored if m["role"] == "user"][1]

        assert other.client.delete(f"/messages/{second_user['id']}", headers=other.headers).status_code == 404
        resp = account.client.delete(f"/messages/{second_user['id']}", headers=account.headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 2, "the message and the reply after it"

        left = account.client.get(f"/conversations/{conversation_id}", headers=account.headers).json()["messages"]
        assert [(m["role"], m["content"]) for m in left] == [("user", "one"), ("assistant", "You said: one")]


class TestToolPolicies:
    def test_put_replaces_them_and_the_next_turn_obeys(self, account, mock_ollama):
        assert account.client.get("/users/me/tool-policies", headers=account.headers).json() == {"tools": {}}

        resp = account.client.put("/users/me/tool-policies", json={"tools": {"history_list": "deny"}}, headers=account.headers)
        assert resp.status_code == 200
        assert account.client.get("/users/me/tool-policies", headers=account.headers).json() == {"tools": {"history_list": "deny"}}

        mock_ollama.state.script(Reply(tool_calls=[ToolCall("history_list", {})]), Reply(content="Refused."))
        with account.socket() as ws:
            ws.receive_json()
            ws.send_json(chat_request("list"))
            events = []
            while not events or events[-1]["type"] not in ("done", "error"):
                events.append(ws.receive_json())
        assert "tool_approval_request" not in {e["type"] for e in events}
        assert [e["tool_status"] for e in events if e["type"] == "stream_chunk" and e["role"] == "tool"] == ["denied"]

    def test_an_invalid_policy_is_refused_and_nothing_changes(self, account):
        account.client.put("/users/me/tool-policies", json={"tools": {"history_list": "allow"}}, headers=account.headers)
        resp = account.client.put("/users/me/tool-policies", json={"tools": {"history_list": "maybe"}}, headers=account.headers)
        assert resp.status_code == 400
        assert account.client.get("/users/me/tool-policies", headers=account.headers).json() == {"tools": {"history_list": "allow"}}

    def test_one_accounts_policy_is_not_anothers(self, account, other):
        account.client.put("/users/me/tool-policies", json={"tools": {"history_list": "deny"}}, headers=account.headers)
        assert other.client.get("/users/me/tool-policies", headers=other.headers).json() == {"tools": {}}


class TestModels:
    def names(self, account):
        resp = account.client.get("/models", headers=account.headers)
        assert resp.status_code == 200, resp.text
        return {m["name"] for m in resp.json()["models"]}

    def test_list_pull_ensure_and_delete_reach_the_accounts_ollama(self, account):
        assert DEFAULT_MODEL in self.names(account)
        details = account.client.get("/models/details", headers=account.headers).json()["models"]
        assert DEFAULT_MODEL in {m["name"] for m in details}

        assert account.client.post("/models/pull", json={"name": "tiny:1b"}, headers=account.headers).status_code == 200
        assert "tiny:1b" in self.names(account)

        ensured = account.client.post("/models/ensure/small:2b", headers=account.headers).json()
        assert "pulled" in ensured["message"]
        again = account.client.post("/models/ensure/small:2b", headers=account.headers).json()
        assert "already available" in again["message"]

        assert account.client.delete("/models/tiny:1b", headers=account.headers).status_code == 200
        assert "tiny:1b" not in self.names(account)

    def test_an_unreachable_ollama_is_a_502_that_says_so(self, account):
        _set_ollama_url(account.username, "http://127.0.0.1:9")
        resp = account.client.get("/models", headers=account.headers)
        assert resp.status_code == 502
        assert "Ollama" in resp.json()["detail"]

    def test_no_ollama_url_lists_nothing_rather_than_failing(self, account):
        from kurisuassistant.db.models import User
        from kurisuassistant.db.session import get_session

        with get_session() as session:
            session.query(User).filter_by(username=account.username).one().ollama_url = None
        resp = account.client.get("/models", headers=account.headers)
        assert resp.status_code == 200
        assert resp.json() == {"models": [], "unavailable": []}


class TestSubAgents:
    def test_create_edit_toggle_export_import_delete(self, account, other):
        created = account.client.post(
            "/sub-agents",
            json={"name": "Researcher", "description": "Looks things up", "system_prompt": "Be thorough.",
                  "available_tools": ["history_list"], "use_deferred_tools": True},
            headers=account.headers,
        )
        assert created.status_code == 200, created.text
        sub = created.json()
        assert sub["enabled"] is True

        patched = account.client.patch(f"/sub-agents/{sub['id']}", json={"model_name": "tiny:1b", "available_tools": None}, headers=account.headers).json()
        assert patched["model_name"] == "tiny:1b"
        assert patched["available_tools"] is None, "null means every tool, and can be set back"
        assert patched["system_prompt"] == "Be thorough.", "an omitted field is left alone"

        toggled = account.client.patch(f"/sub-agents/{sub['id']}/enabled", json={"enabled": False}, headers=account.headers).json()
        assert toggled["enabled"] is False

        assert other.client.get(f"/sub-agents/{sub['id']}", headers=other.headers).status_code == 404
        assert other.client.patch(f"/sub-agents/{sub['id']}", json={"name": "Mine"}, headers=other.headers).status_code == 404

        exported = account.client.get(f"/sub-agents/{sub['id']}/export", headers=account.headers)
        assert exported.status_code == 200
        meta = exported.json()
        assert (meta["version"], meta["kind"]) == (3, "sub_agent")
        assert meta["use_deferred_tools"] is True

        imported = account.client.post(
            "/sub-agents/import",
            files={"file": ("researcher.json", io.BytesIO(json.dumps(meta).encode()), "application/json")},
            headers=account.headers,
        )
        assert imported.status_code == 200, imported.text
        copy = imported.json()
        assert copy["name"] == "Researcher (2)", "an import never takes an existing name"
        assert (copy["system_prompt"], copy["model_name"], copy["use_deferred_tools"]) == ("Be thorough.", "tiny:1b", True)

        assert account.client.delete(f"/sub-agents/{sub['id']}", headers=account.headers).status_code in (200, 204)
        names = [s["name"] for s in account.client.get("/sub-agents", headers=account.headers).json()]
        assert names == ["Researcher (2)"]


class TestMcpServers:
    def test_an_sse_server_is_created_edited_and_deleted_by_its_owner_only(self, account, other):
        created = account.client.post(
            "/mcp-servers", json={"name": "remote", "transport_type": "sse", "url": "http://127.0.0.1:9/sse"},
            headers=account.headers,
        )
        assert created.status_code == 200, created.text
        server = created.json()
        assert server["location"] == "server"

        assert other.client.patch(f"/mcp-servers/{server['id']}", json={"enabled": False}, headers=other.headers).status_code == 404
        assert other.client.delete(f"/mcp-servers/{server['id']}", headers=other.headers).status_code == 404
        assert other.client.get("/mcp-servers", headers=other.headers).json() == []

        patched = account.client.patch(f"/mcp-servers/{server['id']}", json={"enabled": False}, headers=account.headers).json()
        assert patched["enabled"] is False
        assert account.client.delete(f"/mcp-servers/{server['id']}", headers=account.headers).status_code == 200
        assert account.client.get("/mcp-servers", headers=account.headers).json() == []

    def test_a_command_is_never_run_on_the_server(self, account):
        """A stdio server is a command; server-side it would run inside the API
        container on any account's say-so."""
        refused = account.client.post(
            "/mcp-servers", json={"name": "shell", "transport_type": "stdio", "command": "sh", "location": "server"},
            headers=account.headers,
        )
        assert refused.status_code == 422

        client_side = account.client.post(
            "/mcp-servers", json={"name": "local", "transport_type": "stdio", "command": "npx", "location": "client"},
            headers=account.headers,
        ).json()
        moved = account.client.patch(f"/mcp-servers/{client_side['id']}", json={"location": "server"}, headers=account.headers)
        assert moved.status_code == 400, "a patch cannot move a command server-side either"

        sse = account.client.post(
            "/mcp-servers", json={"name": "remote", "transport_type": "sse", "url": "http://127.0.0.1:9/sse"},
            headers=account.headers,
        ).json()
        to_stdio = account.client.patch(f"/mcp-servers/{sse['id']}", json={"transport_type": "stdio", "command": "sh"}, headers=account.headers)
        assert to_stdio.status_code == 400
        stored = {s["id"]: s for s in account.client.get("/mcp-servers", headers=account.headers).json()}
        assert stored[sse["id"]]["transport_type"] == "sse"
        assert stored[client_side["id"]]["location"] == "client"


class TestSkills:
    def test_create_edit_delete_by_the_owner_only(self, account, other):
        created = account.client.post("/skills", json={"name": "Haiku", "instructions": "Five, seven, five."}, headers=account.headers)
        assert created.status_code == 200, created.text
        skill = created.json()

        assert other.client.get("/skills", headers=other.headers).json() == []
        assert other.client.patch(f"/skills/{skill['id']}", json={"instructions": "x"}, headers=other.headers).status_code == 404

        edited = account.client.patch(f"/skills/{skill['id']}", json={"instructions": "Five-seven-five syllables."}, headers=account.headers)
        assert edited.status_code == 200
        listed = account.client.get("/skills", headers=account.headers).json()
        assert [(s["name"], s["instructions"]) for s in listed] == [("Haiku", "Five-seven-five syllables.")]

        assert account.client.delete(f"/skills/{skill['id']}", headers=account.headers).status_code in (200, 204)
        assert account.client.get("/skills", headers=account.headers).json() == []


class TestPersonaPortability:
    def test_an_exported_persona_imports_as_a_copy(self, account):
        persona = account.client.post(
            "/personas",
            json={"name": "Kurisu", "description": "A scientist", "system_prompt": "Be sharp.", "preferred_name": "Okabe"},
            headers=account.headers,
        ).json()

        exported = account.client.get(f"/personas/{persona['id']}/export", headers=account.headers)
        assert exported.status_code == 200
        assert "attachment" in exported.headers["content-disposition"]
        meta = exported.json()

        imported = account.client.post(
            "/personas/import",
            files={"file": ("kurisu.json", io.BytesIO(json.dumps(meta).encode()), "application/json")},
            headers=account.headers,
        )
        assert imported.status_code == 200, imported.text
        copy = imported.json()
        assert copy["id"] != persona["id"]
        assert copy["name"] == "Kurisu (2)"
        assert (copy["description"], copy["system_prompt"], copy["preferred_name"]) == ("A scientist", "Be sharp.", "Okabe")

    def test_a_sub_agent_file_is_not_a_persona(self, account):
        sub = account.client.post("/sub-agents", json={"name": "Worker"}, headers=account.headers).json()
        meta = account.client.get(f"/sub-agents/{sub['id']}/export", headers=account.headers).json()
        resp = account.client.post(
            "/personas/import",
            files={"file": ("worker.json", io.BytesIO(json.dumps(meta).encode()), "application/json")},
            headers=account.headers,
        )
        assert resp.status_code == 400
