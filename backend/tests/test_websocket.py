"""Tests for WebSocket connection, heartbeat, streaming, and reconnection."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.manager import ConnectionManager
from kurisuassistant.websocket.handlers import (
    ChatSessionHandler,
    HEARTBEAT_INTERVAL,
    HEARTBEAT_TIMEOUT,
)
from kurisuassistant.websocket.events import (
    StreamChunkEvent,
    DoneEvent,
    ErrorEvent,
    ConnectedEvent,
    EventType,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_mock_ws(client_state="CONNECTED"):
    """Create a mock WebSocket with the right interface."""
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = client_state
    ws.send_json = AsyncMock()
    ws.receive_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    return ws


# ---------------------------------------------------------------------------
# ConnectionManager
# ---------------------------------------------------------------------------

class TestConnectionManager:
    @pytest.mark.asyncio
    async def test_connect_registers_websocket(self):
        mgr = ConnectionManager()
        ws = make_mock_ws()
        await mgr.connect(ws, "alice")

        assert mgr.is_connected("alice")
        assert mgr.get_connection_count("alice") == 1
        ws.accept.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_removes_websocket(self):
        mgr = ConnectionManager()
        ws = make_mock_ws()
        await mgr.connect(ws, "alice")
        mgr.disconnect(ws, "alice")

        assert not mgr.is_connected("alice")
        assert mgr.get_connection_count("alice") == 0

    @pytest.mark.asyncio
    async def test_multiple_connections_per_user(self):
        mgr = ConnectionManager()
        ws1, ws2 = make_mock_ws(), make_mock_ws()
        await mgr.connect(ws1, "alice")
        await mgr.connect(ws2, "alice")

        assert mgr.get_connection_count("alice") == 2

        mgr.disconnect(ws1, "alice")
        assert mgr.get_connection_count("alice") == 1
        assert mgr.is_connected("alice")

    def test_handler_persistence(self):
        mgr = ConnectionManager()
        handler = MagicMock()
        mgr.set_handler(1, handler)

        assert mgr.get_handler(1) is handler
        assert mgr.get_handler(999) is None

        mgr.remove_handler(1)
        assert mgr.get_handler(1) is None

    @pytest.mark.asyncio
    async def test_send_to_user(self):
        mgr = ConnectionManager()
        ws1, ws2 = make_mock_ws(), make_mock_ws()
        await mgr.connect(ws1, "alice")
        await mgr.connect(ws2, "alice")

        await mgr.send_to_user("alice", {"type": "test"})

        ws1.send_json.assert_called_once_with({"type": "test"})
        ws2.send_json.assert_called_once_with({"type": "test"})

    @pytest.mark.asyncio
    async def test_send_to_disconnected_user_is_noop(self):
        mgr = ConnectionManager()
        await mgr.send_to_user("nobody", {"type": "test"})  # Should not raise


# ---------------------------------------------------------------------------
# ChatSessionHandler — send_event
# ---------------------------------------------------------------------------

class TestSendEvent:
    @pytest.mark.asyncio
    async def test_sends_event_when_connected(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        event = StreamChunkEvent(content="hello", role="assistant", conversation_id=1)
        await handler.send_event(event)

        ws.send_json.assert_called_once()
        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == "stream_chunk"
        assert sent["content"] == "hello"

    @pytest.mark.asyncio
    async def test_drops_event_when_disconnected(self):
        ws = make_mock_ws(client_state="DISCONNECTED")
        handler = ChatSessionHandler(ws, user_id=1)

        event = StreamChunkEvent(content="hello", role="assistant", conversation_id=1)
        await handler.send_event(event)

        ws.send_json.assert_not_called()

    @pytest.mark.asyncio
    async def test_silently_handles_send_exception(self):
        ws = make_mock_ws()
        ws.send_json.side_effect = RuntimeError("socket closed")
        handler = ChatSessionHandler(ws, user_id=1)

        event = StreamChunkEvent(content="hello", role="assistant", conversation_id=1)
        # Should not raise
        await handler.send_event(event)


# ---------------------------------------------------------------------------
# ChatSessionHandler — send_connected_state
# ---------------------------------------------------------------------------

class TestConnectedState:
    @pytest.mark.asyncio
    async def test_sends_connected_event(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        await handler.send_connected_state()

        ws.send_json.assert_called_once()
        sent = ws.send_json.call_args[0][0]
        assert sent["type"] == "connected"
        assert "chat_active" in sent

    @pytest.mark.asyncio
    async def test_connected_state_reflects_active_task(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler.current_task = MagicMock()  # Simulate running task
        handler.current_task.done.return_value = False
        handler._task_conversation_id = 42

        await handler.send_connected_state()

        sent = ws.send_json.call_args[0][0]
        assert sent["chat_active"] is True
        assert sent["conversation_id"] == 42


# ---------------------------------------------------------------------------
# ChatSessionHandler — replace_websocket (reconnection)
# ---------------------------------------------------------------------------

class TestReconnection:
    @pytest.mark.asyncio
    async def test_replace_websocket_updates_reference(self):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)

        await handler.replace_websocket(ws2)

        assert handler.websocket is ws2

    @pytest.mark.asyncio
    async def test_replace_websocket_cancels_old_heartbeat(self):
        ws1 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)

        fake_task = MagicMock()
        handler._heartbeat_task = fake_task

        await handler.replace_websocket(make_mock_ws())

        fake_task.cancel.assert_called_once()
        assert handler._heartbeat_task is None


# ---------------------------------------------------------------------------
# ChatSessionHandler — heartbeat
# ---------------------------------------------------------------------------

class TestHeartbeat:
    @pytest.mark.asyncio
    async def test_heartbeat_sends_ping(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler._last_pong_time = time.monotonic()

        # Run heartbeat with very short intervals for testing
        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.05), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.05):

            task = asyncio.create_task(handler._heartbeat_loop(ws))
            await asyncio.sleep(0.08)  # Let it send one ping

            # Keep updating pong so it doesn't timeout
            handler._last_pong_time = time.monotonic()
            await asyncio.sleep(0.08)

            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Should have sent at least one ping
        ping_calls = [
            c for c in ws.send_json.call_args_list
            if c[0][0] == {"type": "ping"}
        ]
        assert len(ping_calls) >= 1

    @pytest.mark.asyncio
    async def test_heartbeat_timeout_closes_socket(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        # Set pong time far in the past to trigger timeout
        handler._last_pong_time = time.monotonic() - 100

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.02), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.02):

            task = asyncio.create_task(handler._heartbeat_loop(ws))
            await asyncio.sleep(0.1)  # Wait for timeout

            try:
                await task
            except asyncio.CancelledError:
                pass

        ws.close.assert_called_once_with(code=4002, reason="Heartbeat timeout")

    @pytest.mark.asyncio
    async def test_heartbeat_stops_on_websocket_replace(self):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)
        handler._last_pong_time = time.monotonic()

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.05), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.05):

            task = asyncio.create_task(handler._heartbeat_loop(ws1))
            await asyncio.sleep(0.02)

            # Simulate reconnect — replace websocket
            handler.websocket = ws2
            await asyncio.sleep(0.1)  # Heartbeat should detect and stop

            assert task.done()

    @pytest.mark.asyncio
    async def test_pong_resets_timeout(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler._last_pong_time = time.monotonic()

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.05), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.05):

            task = asyncio.create_task(handler._heartbeat_loop(ws))

            # Continuously update pong to prevent timeout
            for _ in range(3):
                await asyncio.sleep(0.04)
                handler._last_pong_time = time.monotonic()

            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Should NOT have closed the socket
        ws.close.assert_not_called()


# ---------------------------------------------------------------------------
# ChatSessionHandler — run loop (pong processing)
# ---------------------------------------------------------------------------

class TestRunLoop:
    @pytest.mark.asyncio
    async def test_pong_updates_last_pong_time(self):
        from starlette.websockets import WebSocketDisconnect

        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        call_count = 0
        initial_time = handler._last_pong_time

        async def receive_side_effect():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {"type": "pong"}
            raise WebSocketDisconnect()

        ws.receive_json = receive_side_effect

        with pytest.raises(WebSocketDisconnect):
            await handler.run()

        assert handler._last_pong_time > initial_time

    @pytest.mark.asyncio
    async def test_unknown_event_sends_error(self):
        from starlette.websockets import WebSocketDisconnect

        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        call_count = 0

        async def receive_side_effect():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return {"type": "nonexistent_event_type", "data": "bad"}
            raise WebSocketDisconnect()

        ws.receive_json = receive_side_effect

        with pytest.raises(WebSocketDisconnect):
            await handler.run()

        # Should have sent an error event before disconnect
        error_calls = [
            c for c in ws.send_json.call_args_list
            if isinstance(c[0][0], dict) and c[0][0].get("type") == "error"
        ]
        assert len(error_calls) == 1
        assert "Unknown event type" in error_calls[0][0][0]["error"]


# ---------------------------------------------------------------------------
# ChatSessionHandler — message queue
# ---------------------------------------------------------------------------

class TestMessageQueue:
    @pytest.mark.asyncio
    async def test_cancel_clears_queue(self):
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        # Simulate queued messages
        handler._message_queue = [MagicMock(), MagicMock()]

        with patch.object(handler, "send_event", new_callable=AsyncMock):
            await handler._handle_cancel()

        assert len(handler._message_queue) == 0


# ---------------------------------------------------------------------------
# Streaming delivery
# ---------------------------------------------------------------------------

class TestStreamingDelivery:
    @pytest.mark.asyncio
    async def test_multiple_chunks_delivered_in_order(self):
        """Simulate streaming: multiple send_event calls deliver in FIFO order."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        chunks = ["Hello", " world", ", how", " are you?"]
        for i, text in enumerate(chunks):
            await handler.send_event(StreamChunkEvent(
                content=text, role="assistant", conversation_id=1,
            ))

        assert ws.send_json.call_count == len(chunks)
        sent_contents = [c[0][0]["content"] for c in ws.send_json.call_args_list]
        assert sent_contents == chunks

    @pytest.mark.asyncio
    async def test_chunks_dropped_after_disconnect(self):
        """After socket disconnects, send_event silently drops events."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        # First chunk succeeds
        await handler.send_event(StreamChunkEvent(
            content="hello", role="assistant", conversation_id=1,
        ))
        assert ws.send_json.call_count == 1

        # Socket disconnects
        ws.client_state.name = "DISCONNECTED"

        # Second chunk is silently dropped
        await handler.send_event(StreamChunkEvent(
            content="world", role="assistant", conversation_id=1,
        ))
        assert ws.send_json.call_count == 1  # Still 1 — not sent

    @pytest.mark.asyncio
    async def test_done_event_after_chunks(self):
        """DoneEvent is delivered after all stream chunks."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        await handler.send_event(StreamChunkEvent(
            content="response text", role="assistant", conversation_id=42,
        ))
        await handler.send_event(DoneEvent(conversation_id=42))

        assert ws.send_json.call_count == 2
        last_event = ws.send_json.call_args_list[-1][0][0]
        assert last_event["type"] == "done"
        assert last_event["conversation_id"] == 42

    @pytest.mark.asyncio
    async def test_concurrent_send_events_are_serialized(self):
        """Multiple concurrent send_event calls are serialized by _send_lock."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        send_order = []
        original_send = ws.send_json

        async def tracking_send(data):
            send_order.append(data["content"])
            await asyncio.sleep(0.01)  # Simulate slow send
            return await original_send(data)

        ws.send_json = tracking_send

        # Fire concurrent sends
        tasks = [
            asyncio.create_task(handler.send_event(StreamChunkEvent(
                content=f"chunk_{i}", role="assistant", conversation_id=1,
            )))
            for i in range(5)
        ]
        await asyncio.gather(*tasks)

        # All 5 should be sent (lock serializes, doesn't drop)
        assert len(send_order) == 5

    @pytest.mark.asyncio
    async def test_voice_reference_propagated_in_chunks(self):
        """voice_reference is included in stream chunk events."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        await handler.send_event(StreamChunkEvent(
            content="konnichiwa",
            role="assistant",
            conversation_id=1,
            voice_reference="abc-123-uuid",
            persona_name="Ayaka",
        ))

        sent = ws.send_json.call_args[0][0]
        assert sent["voice_reference"] == "abc-123-uuid"
        assert sent["persona_name"] == "Ayaka"


# ---------------------------------------------------------------------------
# Connection retention (handler survives reconnects)
# ---------------------------------------------------------------------------

class TestConnectionRetention:
    @pytest.mark.asyncio
    async def test_handler_survives_reconnect(self):
        """Handler persists across WebSocket reconnections."""
        mgr = ConnectionManager()
        ws1 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)
        mgr.set_handler(1, handler)

        # Simulate disconnect
        mgr.disconnect(ws1, "alice")

        # Handler still exists
        assert mgr.get_handler(1) is handler

        # Reconnect with new socket
        ws2 = make_mock_ws()
        await handler.replace_websocket(ws2)

        assert handler.websocket is ws2
        assert mgr.get_handler(1) is handler  # Same handler

    @pytest.mark.asyncio
    async def test_send_event_uses_new_socket_after_reconnect(self):
        """After reconnect, events go to the new WebSocket."""
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)

        await handler.replace_websocket(ws2)

        await handler.send_event(StreamChunkEvent(
            content="hello", role="assistant", conversation_id=1,
        ))

        ws1.send_json.assert_not_called()
        ws2.send_json.assert_called_once()

    @pytest.mark.asyncio
    async def test_task_state_preserved_across_reconnect(self):
        """Running task metadata persists through reconnect."""
        ws1 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)
        handler._task_conversation_id = 42
        handler.current_task = MagicMock()
        handler.current_task.done.return_value = False

        await handler.replace_websocket(make_mock_ws())

        # Task state preserved
        assert handler._task_conversation_id == 42
        assert handler.current_task is not None


# ---------------------------------------------------------------------------
# AFK / idle connection
# ---------------------------------------------------------------------------

class TestIdleConnection:
    @pytest.mark.asyncio
    async def test_connection_stays_alive_with_pong(self):
        """Connection survives multiple heartbeat cycles when pongs are received."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler._last_pong_time = time.monotonic()

        cycles_completed = 0

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.03), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.03):

            task = asyncio.create_task(handler._heartbeat_loop(ws))

            # Simulate 5 heartbeat cycles with timely pongs
            for _ in range(5):
                await asyncio.sleep(0.04)
                handler._last_pong_time = time.monotonic()
                cycles_completed += 1

            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        assert cycles_completed == 5
        ws.close.assert_not_called()

        # Should have sent multiple pings
        ping_calls = [
            c for c in ws.send_json.call_args_list
            if c[0][0] == {"type": "ping"}
        ]
        assert len(ping_calls) >= 3

    @pytest.mark.asyncio
    async def test_connection_dies_without_pong(self):
        """Connection is closed if pong is never received (AFK client)."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        # Pong time is set at start but never updated (simulates AFK client)
        handler._last_pong_time = time.monotonic()

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.03), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.03):

            task = asyncio.create_task(handler._heartbeat_loop(ws))
            # Don't update _last_pong_time — simulate client not responding
            await asyncio.sleep(0.15)

            try:
                await task
            except asyncio.CancelledError:
                pass

        ws.close.assert_called_once_with(code=4002, reason="Heartbeat timeout")

    @pytest.mark.asyncio
    async def test_reconnect_after_idle_disconnect(self):
        """After idle disconnect, handler accepts new WebSocket and works."""
        ws1 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)

        # Simulate: ws1 was closed due to heartbeat timeout
        ws1.client_state.name = "DISCONNECTED"

        # Events to ws1 are dropped
        await handler.send_event(StreamChunkEvent(
            content="lost", role="assistant", conversation_id=1,
        ))
        ws1.send_json.assert_not_called()

        # Reconnect
        ws2 = make_mock_ws()
        await handler.replace_websocket(ws2)

        # Events to ws2 work
        await handler.send_event(StreamChunkEvent(
            content="recovered", role="assistant", conversation_id=1,
        ))
        ws2.send_json.assert_called_once()
        assert ws2.send_json.call_args[0][0]["content"] == "recovered"


# ---------------------------------------------------------------------------
# Event serialization
# ---------------------------------------------------------------------------

class TestEvents:
    def test_stream_chunk_serialization(self):
        event = StreamChunkEvent(
            content="hello world",
            role="assistant",
            conversation_id=1,
            voice_reference="uuid-123",
            persona_name="Ayaka",
            agent_id=5,
        )
        d = event.to_dict()
        assert d["type"] == "stream_chunk"
        assert d["content"] == "hello world"
        assert d["voice_reference"] == "uuid-123"
        assert d["persona_name"] == "Ayaka"
        assert d["agent_id"] == 5

    def test_done_event_serialization(self):
        event = DoneEvent(conversation_id=42)
        d = event.to_dict()
        assert d["type"] == "done"
        assert d["conversation_id"] == 42

    def test_error_event_serialization(self):
        event = ErrorEvent(error="something broke", code="INTERNAL_ERROR")
        d = event.to_dict()
        assert d["type"] == "error"
        assert d["error"] == "something broke"
        assert d["code"] == "INTERNAL_ERROR"

    def test_connected_event_serialization(self):
        event = ConnectedEvent(
            chat_active=True,
            conversation_id=10,
        )
        d = event.to_dict()
        assert d["type"] == "connected"
        assert d["chat_active"] is True
        assert d["conversation_id"] == 10
