"""A WebSocket session must be released when its last connection goes.

Handlers were cached per user and never removed — `remove_handler` existed and
was called only by tests. Each user who connected left behind a handler holding a
dead socket, a vision processor with its loaded models, and the tool list the
previous client had registered.

That stale tool list was the visible bug. Sign in on desktop, which registers
host tools, then open the phone: the same handler was reused, the model was
offered tools the phone cannot run, and every call blocked for the full
120-second timeout.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.handlers import MAX_QUEUED_MESSAGES, ChatSessionHandler
from kurisuassistant.websocket.events import ChatRequestEvent
from kurisuassistant.websocket.manager import ConnectionManager, WS_SUPERSEDED_CODE


def make_ws():
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = "CONNECTED"
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.fixture
def manager():
    return ConnectionManager()


class TestHandlerEviction:
    async def test_handler_is_evicted_when_the_last_connection_closes(self, manager):
        ws = make_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        await manager.connect(ws, user_id=1)
        manager.set_handler(1, handler)

        evicted = manager.disconnect(ws, user_id=1)

        assert evicted is handler
        assert manager.get_handler(1) is None

    async def test_handler_survives_while_another_connection_remains(self, manager):
        first, second = make_ws(), make_ws()
        handler = ChatSessionHandler(first, user_id=1)
        await manager.connect(first, user_id=1)
        await manager.connect(second, user_id=1)
        manager.set_handler(1, handler)

        assert manager.disconnect(first, user_id=1) is None
        assert manager.get_handler(1) is handler

        assert manager.disconnect(second, user_id=1) is handler
        assert manager.get_handler(1) is None

    async def test_disconnecting_an_unknown_socket_is_harmless(self, manager):
        assert manager.disconnect(make_ws(), user_id=99) is None

    async def test_shutdown_releases_the_session(self):
        handler = ChatSessionHandler(make_ws(), user_id=1)
        handler._vision_processor = MagicMock()
        handler._message_queue.append(MagicMock())

        with patch("kurisuassistant.mcp_tools.orchestrator.evict_user_orchestrator") as evict:
            await handler.shutdown()

        assert handler._vision_processor is None
        assert handler._message_queue == []
        evict.assert_called_once_with(1)


class TestClientToolsAreNotInherited:
    """Tools belong to the client that registered them."""

    async def test_replacing_the_socket_clears_them(self):
        handler = ChatSessionHandler(make_ws(), user_id=1)
        handler._client_tools = [{"function": {"name": "host_bash"}}]
        handler._client_tool_names = {"host_bash"}

        await handler.replace_websocket(make_ws())

        assert handler._client_tools == []
        assert handler._client_tool_names == set()

    async def test_pending_calls_do_not_hang_the_next_client(self):
        """A call the old client never answered must not wait out its timeout."""
        import asyncio

        handler = ChatSessionHandler(make_ws(), user_id=1)
        future = asyncio.get_event_loop().create_future()
        handler._pending_tool_calls["req-1"] = future

        await handler.replace_websocket(make_ws())

        assert future.done()
        assert handler._pending_tool_calls == {}


class TestSupersededSessions:
    async def test_an_earlier_socket_is_closed(self, manager):
        first, second = make_ws(), make_ws()
        await manager.connect(first, user_id=1)
        await manager.connect(second, user_id=1)

        await manager.displace_existing(user_id=1, keep=second)

        first.close.assert_awaited_once()
        assert first.close.await_args.kwargs["code"] == WS_SUPERSEDED_CODE
        second.close.assert_not_awaited()

    async def test_the_kept_socket_remains_registered(self, manager):
        first, second = make_ws(), make_ws()
        await manager.connect(first, user_id=1)
        await manager.connect(second, user_id=1)

        await manager.displace_existing(user_id=1, keep=second)

        assert manager.get_connection_count(1) == 1
        assert manager.is_connected(1)


class TestFanOut:
    async def test_a_failing_socket_is_dropped_not_retried(self, manager):
        good, bad = make_ws(), make_ws()
        bad.send_json = AsyncMock(side_effect=RuntimeError("closed"))
        await manager.connect(good, user_id=1)
        await manager.connect(bad, user_id=1)

        await manager.send_to_user(1, {"type": "ping"})
        assert manager.get_connection_count(1) == 1

        await manager.send_to_user(1, {"type": "ping"})
        assert bad.send_json.await_count == 1
        assert good.send_json.await_count == 2

    async def test_a_disconnect_during_send_does_not_raise(self, manager):
        """The set used to be iterated directly, so mutating it mid-send raised."""
        first, second = make_ws(), make_ws()
        await manager.connect(first, user_id=1)
        await manager.connect(second, user_id=1)

        async def disconnect_midway(_data):
            manager.disconnect(second, user_id=1)

        first.send_json = AsyncMock(side_effect=disconnect_midway)
        await manager.send_to_user(1, {"type": "ping"})

    async def test_sending_to_an_absent_user_is_harmless(self, manager):
        await manager.send_to_user(404, {"type": "ping"})


class TestMessageQueueIsBounded:
    async def test_messages_queue_while_a_turn_runs(self):
        handler = ChatSessionHandler(make_ws(), user_id=1)
        handler.current_task = MagicMock()
        handler.current_task.done.return_value = False

        await handler._handle_chat_request(ChatRequestEvent(text="one"))
        assert len(handler._message_queue) == 1

    async def test_the_queue_stops_growing_at_the_cap(self):
        ws = make_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler.current_task = MagicMock()
        handler.current_task.done.return_value = False

        for i in range(MAX_QUEUED_MESSAGES + 5):
            await handler._handle_chat_request(ChatRequestEvent(text=f"msg {i}"))

        assert len(handler._message_queue) == MAX_QUEUED_MESSAGES

    async def test_the_client_is_told_when_the_queue_is_full(self):
        ws = make_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler.current_task = MagicMock()
        handler.current_task.done.return_value = False

        for i in range(MAX_QUEUED_MESSAGES + 1):
            await handler._handle_chat_request(ChatRequestEvent(text=f"msg {i}"))

        sent = [call.args[0] for call in ws.send_json.await_args_list]
        assert any(payload.get("code") == "QUEUE_FULL" for payload in sent)
