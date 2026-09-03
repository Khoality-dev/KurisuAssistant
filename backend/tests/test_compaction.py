"""Tests for the compaction → new-conversation flow.

Covers ``ChatSessionHandler._handle_compact_context``:
- happy path emits ``ConversationSwitchedEvent`` with the new conversation id
  and summary text, and does NOT touch the old conversation.
- missing summary model → ``ErrorEvent``.
- empty conversation → no event, returns silently.
- empty LLM output → ``ErrorEvent``.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.websocket.events import (
    CompactContextEvent,
    ContextInfoEvent,
    ConversationSwitchedEvent,
    ErrorEvent,
)


def make_mock_ws(client_state="CONNECTED"):
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = client_state
    ws.send_json = AsyncMock()
    return ws


def find_event(ws, event_type: str):
    """Return the first send_json call whose payload type matches."""
    for call in ws.send_json.call_args_list:
        payload = call.args[0]
        if payload.get("type") == event_type:
            return payload
    return None


def setup_db_prefs(monkeypatch, summary_model="qwen3:1.7b", agent_id=42):
    """Patch get_db_service so handler reads canned user prefs + agent id."""
    db = MagicMock()
    # _get_prefs returns (summary_model, summary_provider, ollama_url, gemini_api_key, nvidia_api_key, agent_id)
    # _get_ctx returns context_size
    # _create runs the create_summary_conversation closure (returns new id)
    def execute_sync(fn):
        # Run with a dummy session — closure paths we exercise don't touch it
        return fn(MagicMock())

    db.execute_sync = MagicMock(side_effect=lambda fn: {
        "_get_prefs": (summary_model, "ollama", None, None, None, agent_id),
        "_get_ctx": 8192,
    }.get(fn.__name__, execute_sync(fn)))
    return db


class TestHandleCompactContext:
    @pytest.mark.asyncio
    async def test_emits_switched_and_creates_new_conversation(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        with patch.object(handler, "_load_context_messages", return_value=("", 0, [{"role": "user", "content": "hi"}])), \
             patch.object(handler, "_generate_summary", return_value="SUMMARY TEXT"), \
             patch.object(handler, "_create_summary_conversation", return_value=999), \
             patch("kurisuassistant.websocket.handlers.get_db_service") as mock_db:
            mock_db.return_value.execute_sync = lambda fn: ("qwen3:1.7b", "ollama", None, None, None, 42) \
                if fn.__name__ == "_get_prefs" else 8192

            await handler._handle_compact_context(CompactContextEvent(conversation_id=123))

        switched = find_event(ws, "conversation_switched")
        assert switched is not None, "ConversationSwitchedEvent was not emitted"
        assert switched["old_conversation_id"] == 123
        assert switched["new_conversation_id"] == 999
        assert switched["compacted_context"] == "SUMMARY TEXT"
        assert switched["agent_id"] == 42

        # The compacting=true heads-up should also have fired before the switch
        info = find_event(ws, "context_info")
        assert info is not None
        assert info["compacting"] is True

    @pytest.mark.asyncio
    async def test_no_summary_model_emits_error(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        with patch("kurisuassistant.websocket.handlers.get_db_service") as mock_db:
            # summary_model is None → handler should bail with an ErrorEvent
            mock_db.return_value.execute_sync = lambda fn: (None, "ollama", None, None, None, None) \
                if fn.__name__ == "_get_prefs" else 8192

            await handler._handle_compact_context(CompactContextEvent(conversation_id=123))

        err = find_event(ws, "error")
        assert err is not None
        assert err["code"] == "NO_SUMMARY_MODEL"
        assert find_event(ws, "conversation_switched") is None

    @pytest.mark.asyncio
    async def test_empty_conversation_returns_silently(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        with patch.object(handler, "_load_context_messages", return_value=("", 0, [])), \
             patch("kurisuassistant.websocket.handlers.get_db_service") as mock_db:
            mock_db.return_value.execute_sync = lambda fn: ("qwen3:1.7b", "ollama", None, None, None, 42) \
                if fn.__name__ == "_get_prefs" else 8192

            await handler._handle_compact_context(CompactContextEvent(conversation_id=123))

        assert find_event(ws, "conversation_switched") is None
        assert find_event(ws, "error") is None

    @pytest.mark.asyncio
    async def test_empty_summary_emits_error(self, monkeypatch):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        with patch.object(handler, "_load_context_messages", return_value=("", 0, [{"role": "user", "content": "hi"}])), \
             patch.object(handler, "_generate_summary", return_value=""), \
             patch.object(handler, "_create_summary_conversation") as create_mock, \
             patch("kurisuassistant.websocket.handlers.get_db_service") as mock_db:
            mock_db.return_value.execute_sync = lambda fn: ("qwen3:1.7b", "ollama", None, None, None, 42) \
                if fn.__name__ == "_get_prefs" else 8192

            await handler._handle_compact_context(CompactContextEvent(conversation_id=123))

        err = find_event(ws, "error")
        assert err is not None
        assert err["code"] == "COMPACT_EMPTY"
        assert find_event(ws, "conversation_switched") is None
        create_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_zero_conversation_id_noop(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        await handler._handle_compact_context(CompactContextEvent(conversation_id=0))

        ws.send_json.assert_not_called()


class TestEventShape:
    def test_conversation_switched_event_serializes(self):
        evt = ConversationSwitchedEvent(
            old_conversation_id=10,
            new_conversation_id=11,
            compacted_context="…",
            agent_id=5,
        )
        d = evt.to_dict()
        assert d["type"] == "conversation_switched"
        assert d["old_conversation_id"] == 10
        assert d["new_conversation_id"] == 11
        assert d["compacted_context"] == "…"
        assert d["agent_id"] == 5
