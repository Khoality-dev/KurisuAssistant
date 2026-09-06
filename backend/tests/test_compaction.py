"""Compaction trims the conversation it is given; it does not fork it (#99).

Covers ``ChatSessionHandler._handle_compact_context``:

- the happy path writes ``compacted_context`` and moves ``compacted_up_to_id``
  to the last message it summarized, on the same conversation, and announces it
  with ``context_info``;
- no summary model, an empty conversation and empty LLM output are refused
  without touching the conversation;
- **every** path that starts the client's spinner also stops it.

Compaction used to create a second conversation and emit
``conversation_switched``, so a long thread quietly became several in the
history list while the watermark it wrote (0) trimmed nothing at all.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.websocket.events import (
    CompactContextEvent,
    ContextInfoEvent,
    ErrorEvent,
)


def make_mock_ws(client_state="CONNECTED"):
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = client_state
    ws.send_json = AsyncMock()
    return ws


def events_of(ws, event_type: str):
    """Every payload of a type, in the order they were sent."""
    return [
        call.args[0] for call in ws.send_json.call_args_list
        if call.args[0].get("type") == event_type
    ]


def find_event(ws, event_type: str):
    found = events_of(ws, event_type)
    return found[0] if found else None


def setup_db_prefs(monkeypatch, summary_model="qwen3:1.7b", persona_id=42):
    """Patch get_db_service so the handler reads canned prefs and persona id."""
    db = MagicMock()

    def execute_sync(fn):
        return fn(MagicMock())

    def dispatch(fn):
        return {
            "_get_prefs": (summary_model, "ollama", None, None, None, None, persona_id),
            "_get_ctx": 8192,
            # The in-place write returns nothing; it must not blow up here.
            "_write": None,
        }.get(fn.__name__, execute_sync(fn))

    db.execute = AsyncMock(side_effect=dispatch)
    db.execute_sync = MagicMock(side_effect=dispatch)
    return db


CONTEXT = ("", 0, [{"role": "user", "content": "hi"}], 77)


class TestHandleCompactContext:
    @pytest.mark.asyncio
    async def test_it_compacts_the_same_conversation_in_place(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        db = setup_db_prefs(monkeypatch)

        with patch.object(handler, "_load_context_messages", new_callable=AsyncMock, return_value=CONTEXT), \
             patch.object(handler, "_generate_summary", return_value="SUMMARY TEXT"), \
             patch.object(handler, "_compact_in_place", new_callable=AsyncMock) as compact, \
             patch("kurisuassistant.websocket.handlers.get_db_service", lambda: db):
            await handler._handle_compact_context(CompactContextEvent(conversation_id=5))

        compact.assert_awaited_once_with(5, "SUMMARY TEXT", 77)

        assert find_event(ws, "conversation_switched") is None, "compaction must not fork"
        infos = events_of(ws, "context_info")
        assert [i["compacting"] for i in infos] == [True, False]
        assert infos[-1]["conversation_id"] == 5, "the conversation keeps its identity"
        assert infos[-1]["compacted_up_to_id"] == 77
        assert infos[-1]["compacted_context"] == "SUMMARY TEXT"

    @pytest.mark.asyncio
    async def test_no_summary_model_emits_error(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        db = setup_db_prefs(monkeypatch, summary_model=None)

        with patch.object(handler, "_load_context_messages", new_callable=AsyncMock, return_value=CONTEXT), \
             patch.object(handler, "_compact_in_place", new_callable=AsyncMock) as compact, \
             patch("kurisuassistant.websocket.handlers.get_db_service", lambda: db):
            await handler._handle_compact_context(CompactContextEvent(conversation_id=5))

        error = find_event(ws, "error")
        assert error is not None and error["code"] == "NO_SUMMARY_MODEL"
        compact.assert_not_awaited()
        assert events_of(ws, "context_info") == [], "the spinner never started, so nothing to stop"

    @pytest.mark.asyncio
    async def test_empty_conversation_returns_silently(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        db = setup_db_prefs(monkeypatch)

        with patch.object(handler, "_load_context_messages", new_callable=AsyncMock, return_value=("", 0, [], 0)), \
             patch.object(handler, "_compact_in_place", new_callable=AsyncMock) as compact, \
             patch("kurisuassistant.websocket.handlers.get_db_service", lambda: db):
            await handler._handle_compact_context(CompactContextEvent(conversation_id=5))

        assert events_of(ws, "context_info") == []
        compact.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_summary_stops_the_spinner_it_started(self, monkeypatch):
        """The bug this test exists for: the error path returned while the
        client was still showing a compaction in progress (#99)."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        db = setup_db_prefs(monkeypatch)

        with patch.object(handler, "_load_context_messages", new_callable=AsyncMock, return_value=CONTEXT), \
             patch.object(handler, "_generate_summary", return_value=""), \
             patch.object(handler, "_compact_in_place", new_callable=AsyncMock) as compact, \
             patch("kurisuassistant.websocket.handlers.get_db_service", lambda: db):
            await handler._handle_compact_context(CompactContextEvent(conversation_id=5))

        error = find_event(ws, "error")
        assert error is not None and error["code"] == "COMPACT_EMPTY"
        compact.assert_not_awaited(), "nothing was summarized, so nothing may be trimmed"
        infos = events_of(ws, "context_info")
        assert [i["compacting"] for i in infos] == [True, False]
        assert infos[-1]["compacted_up_to_id"] == 0, "no watermark may move on a failure"

    @pytest.mark.asyncio
    async def test_a_failing_summary_call_stops_the_spinner_too(self, monkeypatch):
        """An unreachable summary model raises rather than returning empty."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        db = setup_db_prefs(monkeypatch)

        with patch.object(handler, "_load_context_messages", new_callable=AsyncMock, return_value=CONTEXT), \
             patch.object(handler, "_generate_summary", side_effect=ConnectionError("refused")), \
             patch.object(handler, "_compact_in_place", new_callable=AsyncMock), \
             patch("kurisuassistant.websocket.handlers.get_db_service", lambda: db):
            with pytest.raises(ConnectionError):
                await handler._handle_compact_context(CompactContextEvent(conversation_id=5))

        infos = events_of(ws, "context_info")
        assert [i["compacting"] for i in infos] == [True, False]

    @pytest.mark.asyncio
    async def test_zero_conversation_id_noop(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        await handler._handle_compact_context(CompactContextEvent(conversation_id=0))
        ws.send_json.assert_not_called()


class TestTheForkIsGone:
    def test_no_conversation_switched_event_exists(self):
        """One compaction model, not two half-present ones (#99)."""
        import kurisuassistant.websocket.events as events

        assert not hasattr(events, "ConversationSwitchedEvent")
        assert "conversation_switched" not in {e.value for e in events.EventType}

    def test_the_handler_no_longer_creates_conversations_to_compact(self):
        import inspect

        from kurisuassistant.websocket import handlers

        source = inspect.getsource(handlers)
        assert "_create_summary_conversation" not in source
        assert "Continued conversation" not in source


class TestEventShape:
    def test_context_info_carries_the_watermark_and_summary(self):
        d = ContextInfoEvent(
            conversation_id=5, compacting=False,
            compacted_up_to_id=77, compacted_context="…",
        ).to_dict()
        assert d["type"] == "context_info"
        assert d["conversation_id"] == 5
        assert d["compacting"] is False
        assert d["compacted_up_to_id"] == 77
        assert d["compacted_context"] == "…"
