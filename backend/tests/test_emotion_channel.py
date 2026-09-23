"""The emotion channel end to end: from the model's tags to the stored cues (#243).

Three layers, each pinned where it can break on its own:

* the agent loop — tags leave the stream as ``emotion``/``emotion_at`` on the
  chunk that follows them, the text the model sees next round carries no tag,
  and the ``tool_calls`` chunk survives a tagged reply;
* the handler — cues are collected per assistant message, reset with it, and
  reach ``_save_message`` beside ``tool_calls``;
* the system — a real turn through the WebSocket against the mock model,
  then the history and raw endpoints (needs Postgres, like the other ``db``
  tests).
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.agents.base import AssistantConfig, PersonaConfig, AgentContext
from kurisuassistant.agents.main import MainAgent
from kurisuassistant.tools import ToolRegistry
from kurisuassistant.websocket.events import StreamChunkEvent


VRM_ON = {"kind": "vrm", "vrm": {"emotion": {"enabled": True}}}


def agent(character_config=VRM_ON):
    return MainAgent(
        AssistantConfig(id=1), ToolRegistry(),
        identity=PersonaConfig(id=1, name="Tester", character_config=character_config),
    )


def context():
    ctx = AgentContext(user_id=1, conversation_id=7, model_name="test-model")
    ctx.handler = None
    ctx.tool_policies = {"lookup": "allow"}
    return ctx


# --- a provider that streams scripted pieces and remembers what it was sent ---

class FakeFunction:
    def __init__(self, name, arguments):
        self.name = name
        self.arguments = arguments


class FakeToolCall:
    def __init__(self, name, arguments):
        self.function = FakeFunction(name, arguments)


class FakeMessage:
    def __init__(self, content="", tool_calls=None, thinking=None):
        self.content = content
        self.thinking = thinking
        self.tool_calls = tool_calls or []


class FakeChunk:
    def __init__(self, message):
        self.message = message


class FakeProvider:
    def __init__(self, turns):
        self._turns = iter(turns)
        self.sent = []

    def chat(self, **kwargs):
        self.sent.append([dict(m) for m in kwargs["messages"]])
        return iter(next(self._turns))


async def run_turns(turns, character_config=VRM_ON):
    provider = FakeProvider(turns)
    a = agent(character_config)
    with patch("kurisuassistant.models.llm.create_llm_provider", return_value=provider), \
         patch.object(MainAgent, "execute_tool", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = MagicMock(content="42", status="success", images=[])
        events = [c async for c in a.process([{"role": "user", "content": "hi"}], context())]
    return events, provider


def assistant_text(events):
    return "".join(e.content for e in events if e.role == "assistant")


class TestTheAgentLoop:
    async def test_tags_leave_the_stream_as_cues_on_the_following_text(self):
        events, _ = await run_turns([[
            FakeChunk(FakeMessage("[[emo")),
            FakeChunk(FakeMessage("tion:happy]]Hi. ")),
            FakeChunk(FakeMessage("[[emotion:sad]]Bye.")),
        ]])
        assert assistant_text(events) == "Hi. Bye."
        cues = [(e.emotion_at, e.emotion, e.content) for e in events if e.emotion is not None]
        assert cues == [(0, "happy", "Hi. "), (4, "sad", "Bye.")]
        assert all("[[" not in e.content for e in events)

    async def test_a_chunk_that_is_only_a_partial_tag_is_not_emitted(self):
        events, _ = await run_turns([[FakeChunk(FakeMessage("[[emo")), FakeChunk(FakeMessage("tion:happy]]x"))]])
        assert [e.content for e in events if e.role == "assistant"] == ["x"]

    async def test_text_before_a_tag_goes_out_without_a_cue(self):
        events, _ = await run_turns([[FakeChunk(FakeMessage("Well. [[emotion:angry]]No."))]])
        pieces = [(e.content, e.emotion, e.emotion_at) for e in events if e.role == "assistant"]
        assert pieces == [("Well. ", None, None), ("No.", "angry", 6)]

    async def test_a_dangling_partial_is_released_at_the_end_of_the_round(self):
        events, _ = await run_turns([[FakeChunk(FakeMessage("Bye [[emo"))]])
        assert assistant_text(events) == "Bye [[emo"

    async def test_the_next_round_sees_no_tags(self):
        """The replayed assistant message is the clean text; the model never learns to echo tags."""
        events, provider = await run_turns([
            [FakeChunk(FakeMessage("[[emotion:happy]]Looking that up.", tool_calls=[FakeToolCall("lookup", {})]))],
            [FakeChunk(FakeMessage("[[emotion:sad]]Nothing there."))],
        ])
        replayed = [m for m in provider.sent[1] if m["role"] == "assistant"]
        assert replayed[0]["content"] == "Looking that up."
        assert assistant_text(events) == "Looking that up.Nothing there."

    async def test_offsets_restart_with_each_round(self):
        events, _ = await run_turns([
            [FakeChunk(FakeMessage("[[emotion:happy]]Looking that up.", tool_calls=[FakeToolCall("lookup", {})]))],
            [FakeChunk(FakeMessage("Well. [[emotion:sad]]Nothing there."))],
        ])
        cues = [(e.emotion_at, e.emotion) for e in events if e.emotion is not None]
        assert cues == [(0, "happy"), (6, "sad")], "the second round counts from its own start"

    async def test_the_tool_calls_chunk_survives_a_tagged_reply(self):
        events, _ = await run_turns([
            [FakeChunk(FakeMessage("[[emotion:happy]]Looking.", tool_calls=[FakeToolCall("lookup", {})]))],
            [FakeChunk(FakeMessage("Done."))],
        ])
        announcing = [e for e in events if e.role == "assistant" and e.tool_calls]
        assert len(announcing) == 1 and announcing[0].content == ""
        assert announcing[0].tool_calls[0]["function"]["name"] == "lookup"

    async def test_thinking_chunks_are_untouched(self):
        events, _ = await run_turns([[
            FakeChunk(FakeMessage("", thinking="hmm")),
            FakeChunk(FakeMessage("[[emotion:relaxed]]ok")),
        ]])
        assert [e.thinking for e in events if e.thinking] == ["hmm"]

    async def test_the_round_logs_its_tag_counts(self, caplog):
        """The compliance signal: one INFO line per round. (A mis-formatted log
        line here once turned a whole turn into an error event.)"""
        import logging

        with caplog.at_level(logging.INFO, logger="kurisuassistant.agents.main"):
            await run_turns([[FakeChunk(FakeMessage("[[emotion:happy]]a [[emotion:nope]]b"))]])
        assert "1 known, 1 unknown" in caplog.text

    async def test_a_persona_without_the_channel_streams_verbatim(self):
        """No reader without the prompt: a stray tag from an unasked model is shown, not eaten."""
        events, _ = await run_turns(
            [[FakeChunk(FakeMessage("[[emotion:happy]]Hi."))]],
            character_config={"kind": "pose_graph", "pose_tree": {"nodes": [], "edges": [], "default_pose_ids": []}},
        )
        assert assistant_text(events) == "[[emotion:happy]]Hi."
        assert all(e.emotion is None for e in events)


# --- the handler collects the cues per assistant message -------------------

def chunk(content, role="assistant", **kw):
    return StreamChunkEvent(content=content, role=role, conversation_id=7, **kw)


class FakeAgent:
    def __init__(self, events):
        self._events = events
        self.last_prepared_messages = []

    async def process(self, messages, context):
        for e in self._events:
            yield e


async def stream_and_save(events):
    from kurisuassistant.websocket.handlers import ChatSessionHandler

    handler = ChatSessionHandler(MagicMock(), user_id=1)
    saved = []

    async def capture(msg, conversation_id):
        saved.append(msg)

    with patch.object(handler, "send_event", new=AsyncMock()), \
         patch.object(handler, "_save_message", new=capture):
        persona = PersonaConfig(id=1, name="Tester", character_config=VRM_ON)
        await handler._stream_and_save_agent(
            FakeAgent(events), persona, [], AgentContext(user_id=1, conversation_id=7), 7, [],
        )
    return saved


class TestTheHandler:
    async def test_cues_are_stored_on_the_assistant_message(self):
        saved = await stream_and_save([
            chunk("Hi. ", emotion="happy", emotion_at=0),
            chunk("Bye.", emotion="sad", emotion_at=4),
        ])
        assert len(saved) == 1
        assert saved[0]["content"] == "Hi. Bye."
        assert saved[0]["emotion_cues"] == [{"emotion": "happy", "at": 0}, {"emotion": "sad", "at": 4}]

    async def test_no_cues_means_none_not_an_empty_list(self):
        saved = await stream_and_save([chunk("Plain.")])
        assert saved[0]["emotion_cues"] is None

    async def test_cues_reset_with_each_assistant_message_and_tool_calls_survive(self):
        saved = await stream_and_save([
            chunk("Looking.", emotion="happy", emotion_at=0),
            chunk("", tool_calls=[{"id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": {}}}]),
            chunk("42", role="tool", name="lookup", tool_call_id="call_1", tool_status="success"),
            chunk("Well. ", persona_name="Tester"),
            chunk("Nothing.", emotion="sad", emotion_at=6),
        ])
        roles = [m["role"] for m in saved]
        assert roles == ["assistant", "tool", "assistant"]
        assert saved[0]["emotion_cues"] == [{"emotion": "happy", "at": 0}]
        assert saved[0]["tool_calls"][0]["id"] == "call_1"
        assert saved[1]["emotion_cues"] is None, "a tool message has no feeling"
        assert saved[2]["emotion_cues"] == [{"emotion": "sad", "at": 6}]


# --- the whole thing, persisted ----------------------------------------------

@pytest.mark.db
class TestPersisted:
    @pytest.fixture()
    def headers(self, system_client):
        from tests.conftest import SYSTEM_TEST_PASSWORD, SYSTEM_TEST_USER
        from kurisuassistant.version import WIRE_PROTOCOL

        resp = system_client.post("/login", data={"username": SYSTEM_TEST_USER, "password": SYSTEM_TEST_PASSWORD})
        assert resp.status_code == 200, resp.text
        return {"Authorization": f"Bearer {resp.json()['access_token']}", "X-Wire-Protocol": str(WIRE_PROTOCOL)}

    @pytest.fixture()
    def vrm_persona(self, system_client, headers):
        """A VRM persona with emotion on, made the account's default for the test.

        The account starts with no persona (#302), so the fixture makes one and
        takes it away again, leaving the assistant answering as itself."""
        resp = system_client.post(
            "/personas", json={"name": "Vrm tester", "character_config": VRM_ON}, headers=headers,
        )
        assert resp.status_code == 200, resp.text
        persona = resp.json()
        system_client.patch("/assistant", json={"default_persona_id": persona["id"]}, headers=headers)
        yield persona
        system_client.delete(f"/personas/{persona['id']}", headers=headers)

    def _turn(self, system_client, headers, text, conversation_id=None):
        from tests.test_system_chat import chat_request, events_until_done

        with system_client.websocket_connect("/ws/chat", headers=headers) as ws:
            ws.receive_json()
            ws.send_json(chat_request(text, conversation_id=conversation_id))
            return events_until_done(ws)

    def test_a_tagged_reply_is_stored_clean_with_its_cues(self, system_client, headers, mock_ollama, vrm_persona):
        from tests.mock_ollama import Reply

        mock_ollama.state.script(Reply(content="[[emotion:happy]]Hello there. [[emotion:sad]]Goodbye."))
        events = self._turn(system_client, headers, "hi")
        assert events[-1]["type"] == "done"

        streamed = [e for e in events if e["type"] == "stream_chunk" and e["role"] == "assistant"]
        assert "".join(e["content"] for e in streamed) == "Hello there. Goodbye."
        assert [(e["emotion_at"], e["emotion"]) for e in streamed if e.get("emotion")] == [(0, "happy"), (13, "sad")]

        conversation_id = events[-1]["conversation_id"]
        history = system_client.get(f"/conversations/{conversation_id}", headers=headers).json()
        assistant = [m for m in history["messages"] if m["role"] == "assistant"][-1]
        assert assistant["content"] == "Hello there. Goodbye."
        assert assistant["emotion_cues"] == [{"emotion": "happy", "at": 0}, {"emotion": "sad", "at": 13}]

        raw = system_client.get(f"/messages/{assistant['id']}/raw", headers=headers).json()
        assert raw["raw_output"] == "Hello there. Goodbye.", "raw_output is the stripped text; the cues are the record"

    def test_a_user_message_and_an_untagged_reply_carry_no_cues(self, system_client, headers, mock_ollama, vrm_persona):
        events = self._turn(system_client, headers, "plain")
        history = system_client.get(f"/conversations/{events[-1]['conversation_id']}", headers=headers).json()
        assert all("emotion_cues" not in m for m in history["messages"])

    def test_a_tagged_reply_with_a_tool_call_keeps_the_calls(self, system_client, headers, mock_ollama, vrm_persona):
        from tests.mock_ollama import Reply, ToolCall
        from tests.test_system_chat import TOOL, set_tool_policy

        set_tool_policy(system_client, headers, "allow")
        mock_ollama.state.script(
            Reply(content="[[emotion:relaxed]]Let me look.", tool_calls=[ToolCall(TOOL, {"limit": 3})]),
            Reply(content="Found it. [[emotion:surprised]]Oh!"),
        )
        try:
            events = self._turn(system_client, headers, "what did we say?")
        finally:
            set_tool_policy(system_client, headers, None)
        assert events[-1]["type"] == "done"

        history = system_client.get(f"/conversations/{events[-1]['conversation_id']}", headers=headers).json()
        assistants = [m for m in history["messages"] if m["role"] == "assistant"]
        first, last = assistants[-2], assistants[-1]
        assert first["content"] == "Let me look."
        assert first["emotion_cues"] == [{"emotion": "relaxed", "at": 0}]
        assert last["content"] == "Found it. Oh!"
        assert last["emotion_cues"] == [{"emotion": "surprised", "at": 10}]
        # The next turn's prompt replays the linkage, so the calls were stored.
        turns = mock_ollama.state.requests_to("/api/chat")
        assert any(m["role"] == "tool" for m in turns[-1]["messages"])
