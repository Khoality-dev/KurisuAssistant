"""Stress tests for WebSocket connection and streaming under load."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.manager import ConnectionManager
from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.websocket.events import StreamChunkEvent, DoneEvent, ErrorEvent


def make_mock_ws(client_state="CONNECTED"):
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = client_state
    ws.send_json = AsyncMock()
    ws.receive_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    return ws


# ---------------------------------------------------------------------------
# High-volume streaming
# ---------------------------------------------------------------------------

class TestHighVolumeStreaming:
    @pytest.mark.asyncio
    async def test_1000_chunks_delivered(self):
        """1000 stream chunks all delivered in order."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        for i in range(1000):
            await handler.send_event(StreamChunkEvent(
                content=f"chunk_{i}", role="assistant", conversation_id=1,
            ))

        assert ws.send_json.call_count == 1000
        # Verify order
        for i in range(1000):
            assert ws.send_json.call_args_list[i][0][0]["content"] == f"chunk_{i}"

    @pytest.mark.asyncio
    async def test_concurrent_100_sends(self):
        """100 concurrent send_event calls all succeed (lock serializes)."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        tasks = [
            asyncio.create_task(handler.send_event(StreamChunkEvent(
                content=f"c_{i}", role="assistant", conversation_id=1,
            )))
            for i in range(100)
        ]
        await asyncio.gather(*tasks)

        assert ws.send_json.call_count == 100

    @pytest.mark.asyncio
    async def test_large_payload_chunks(self):
        """Large content chunks (10KB each) delivered without issue."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        large_text = "x" * 10_000
        for i in range(50):
            await handler.send_event(StreamChunkEvent(
                content=large_text, role="assistant", conversation_id=1,
            ))

        assert ws.send_json.call_count == 50


# ---------------------------------------------------------------------------
# Rapid reconnection
# ---------------------------------------------------------------------------

class TestRapidReconnection:
    @pytest.mark.asyncio
    async def test_10_rapid_reconnects(self):
        """Handler survives 10 rapid WebSocket replacements."""
        ws_initial = make_mock_ws()
        handler = ChatSessionHandler(ws_initial, user_id=1)

        for i in range(10):
            new_ws = make_mock_ws()
            await handler.replace_websocket(new_ws)
            assert handler.websocket is new_ws

        # Final socket receives events
        await handler.send_event(StreamChunkEvent(
            content="final", role="assistant", conversation_id=1,
        ))
        handler.websocket.send_json.assert_called_once()

    @pytest.mark.asyncio
    async def test_send_during_reconnect_cycle(self):
        """Events sent between rapid reconnects go to the latest socket."""
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        sockets = []

        for i in range(5):
            ws = make_mock_ws()
            sockets.append(ws)
            await handler.replace_websocket(ws)

            # Send event on each new socket
            await handler.send_event(StreamChunkEvent(
                content=f"msg_{i}", role="assistant", conversation_id=1,
            ))

        # Each socket should have received exactly one event
        for i, ws in enumerate(sockets):
            assert ws.send_json.call_count == 1
            assert ws.send_json.call_args[0][0]["content"] == f"msg_{i}"


# ---------------------------------------------------------------------------
# Connection manager under load
# ---------------------------------------------------------------------------

class TestConnectionManagerStress:
    @pytest.mark.asyncio
    async def test_50_concurrent_users(self):
        """50 users connecting simultaneously."""
        mgr = ConnectionManager()
        sockets = []

        for i in range(50):
            ws = make_mock_ws()
            sockets.append((f"user_{i}", ws))
            await mgr.connect(ws, f"user_{i}")

        for username, _ in sockets:
            assert mgr.is_connected(username)
            assert mgr.get_connection_count(username) == 1

        # Disconnect all
        for username, ws in sockets:
            mgr.disconnect(ws, username)

        for username, _ in sockets:
            assert not mgr.is_connected(username)

    @pytest.mark.asyncio
    async def test_multiple_connections_per_user_stress(self):
        """Single user with 20 concurrent connections."""
        mgr = ConnectionManager()
        sockets = []

        for _ in range(20):
            ws = make_mock_ws()
            sockets.append(ws)
            await mgr.connect(ws, "alice")

        assert mgr.get_connection_count("alice") == 20

        # Broadcast to all
        await mgr.send_to_user("alice", {"type": "test"})
        for ws in sockets:
            ws.send_json.assert_called_once_with({"type": "test"})

    @pytest.mark.asyncio
    async def test_handler_set_get_remove_cycle(self):
        """Rapid handler set/get/remove cycles don't corrupt state."""
        mgr = ConnectionManager()

        for i in range(100):
            handler = MagicMock()
            mgr.set_handler(i, handler)
            assert mgr.get_handler(i) is handler

        for i in range(100):
            mgr.remove_handler(i)
            assert mgr.get_handler(i) is None


# ---------------------------------------------------------------------------
# Heartbeat under load
# ---------------------------------------------------------------------------

class TestHeartbeatUnderLoad:
    @pytest.mark.asyncio
    async def test_heartbeat_with_concurrent_streaming(self):
        """Heartbeat pings still sent while streaming chunks concurrently."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler._last_pong_time = time.monotonic()

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.05), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.05):

            heartbeat = asyncio.create_task(handler._heartbeat_loop(ws))

            # Stream 50 chunks while heartbeat is running
            for i in range(50):
                await handler.send_event(StreamChunkEvent(
                    content=f"c_{i}", role="assistant", conversation_id=1,
                ))
                handler._last_pong_time = time.monotonic()
                if i % 10 == 0:
                    await asyncio.sleep(0.01)

            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass

        # Both chunks and pings were sent
        all_sends = ws.send_json.call_args_list
        chunk_sends = [c for c in all_sends if c[0][0].get("type") == "stream_chunk"]
        ping_sends = [c for c in all_sends if c[0][0] == {"type": "ping"}]

        assert len(chunk_sends) == 50
        assert len(ping_sends) >= 1  # At least one ping during streaming
        ws.close.assert_not_called()

    @pytest.mark.asyncio
    async def test_slow_send_doesnt_block_heartbeat_permanently(self):
        """Slow ws.send_json doesn't permanently block heartbeat from running."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)
        handler._last_pong_time = time.monotonic()

        call_count = 0

        async def slow_send(data):
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.01)  # Simulate network latency

        ws.send_json = slow_send

        with patch("kurisuassistant.websocket.handlers.HEARTBEAT_INTERVAL", 0.05), \
             patch("kurisuassistant.websocket.handlers.HEARTBEAT_TIMEOUT", 0.05):

            heartbeat = asyncio.create_task(handler._heartbeat_loop(ws))

            # Send events while heartbeat runs
            for _ in range(10):
                await handler.send_event(StreamChunkEvent(
                    content="x", role="assistant", conversation_id=1,
                ))
                handler._last_pong_time = time.monotonic()

            await asyncio.sleep(0.1)
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass

        # Both streaming sends and heartbeat pings went through
        assert call_count > 10  # 10 chunks + at least 1 ping


# ---------------------------------------------------------------------------
# Mid-stream disconnect and recovery
# ---------------------------------------------------------------------------

class TestMidStreamDisconnect:
    @pytest.mark.asyncio
    async def test_disconnect_mid_stream_drops_remaining(self):
        """If socket disconnects mid-stream, remaining chunks are dropped."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        # Send 5 chunks successfully
        for i in range(5):
            await handler.send_event(StreamChunkEvent(
                content=f"ok_{i}", role="assistant", conversation_id=1,
            ))

        assert ws.send_json.call_count == 5

        # Socket dies
        ws.client_state.name = "DISCONNECTED"

        # Next 5 chunks are silently dropped
        for i in range(5):
            await handler.send_event(StreamChunkEvent(
                content=f"lost_{i}", role="assistant", conversation_id=1,
            ))

        assert ws.send_json.call_count == 5  # Still 5

    @pytest.mark.asyncio
    async def test_reconnect_mid_stream_resumes_delivery(self):
        """After reconnect, new chunks go to the new socket."""
        ws1 = make_mock_ws()
        handler = ChatSessionHandler(ws1, user_id=1)

        # Send chunks on ws1
        for i in range(3):
            await handler.send_event(StreamChunkEvent(
                content=f"ws1_{i}", role="assistant", conversation_id=1,
            ))
        assert ws1.send_json.call_count == 3

        # Reconnect
        ws2 = make_mock_ws()
        await handler.replace_websocket(ws2)

        # New chunks go to ws2
        for i in range(3):
            await handler.send_event(StreamChunkEvent(
                content=f"ws2_{i}", role="assistant", conversation_id=1,
            ))

        assert ws1.send_json.call_count == 3  # Unchanged
        assert ws2.send_json.call_count == 3

    @pytest.mark.asyncio
    async def test_error_event_survives_stream_failure(self):
        """ErrorEvent can be sent even after stream chunks fail."""
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        # Sending stream chunks fails
        ws.send_json.side_effect = RuntimeError("broken pipe")
        await handler.send_event(StreamChunkEvent(
            content="fail", role="assistant", conversation_id=1,
        ))

        # Reset — socket recovers (or new socket)
        ws.send_json.side_effect = None
        ws.send_json.reset_mock()

        await handler.send_event(ErrorEvent(error="stream failed", code="STREAM_ERROR"))
        ws.send_json.assert_called_once()
        assert ws.send_json.call_args[0][0]["type"] == "error"
