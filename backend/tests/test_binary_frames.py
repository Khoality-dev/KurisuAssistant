"""Webcam frames arrive as binary messages, and a bad one is refused (#111).

A frame used to be base64 JPEG inside a JSON event on the chat socket: a third
more bytes, a JSON parse before the payload was looked at, and — the reason the
issue was filed — the pixels sitting in the send buffer in front of the
assistant's next token. These cover the envelope, the receive loop that has to
tell text from bytes, and the refusals that must not close a conversation.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import WebSocketDisconnect

from kurisuassistant.websocket.binary import (
    BINARY_PROTOCOL_VERSION,
    HEADER_PREFIX_BYTES,
    MAX_HEADER_BYTES,
    MAX_MESSAGE_BYTES,
    BinaryFrameError,
    BinaryMessageType,
    encode_binary_message,
    parse_binary_message,
)
from kurisuassistant.websocket.events import VisionFrameEvent, parse_event
from kurisuassistant.websocket.handlers import ChatSessionHandler

JPEG = b"\xff\xd8\xff\xe0not-really-a-jpeg\xff\xd9"


def frame(payload: bytes = JPEG, header: dict | None = None) -> bytes:
    return encode_binary_message(BinaryMessageType.VISION_FRAME, payload, header)


class TestTheEnvelope:
    def test_a_frame_round_trips(self):
        message = parse_binary_message(frame(header={"event_id": "abc"}))
        assert message.type is BinaryMessageType.VISION_FRAME
        assert message.header == {"event_id": "abc"}
        assert message.payload == JPEG

    def test_an_empty_header_is_allowed(self):
        assert parse_binary_message(frame(header={})).payload == JPEG

    def test_the_payload_is_not_copied_through_json(self):
        """The bytes on the wire are the JPEG itself — no base64, no escaping."""
        encoded = frame()
        assert encoded.endswith(JPEG)
        assert len(encoded) == HEADER_PREFIX_BYTES + 2 + len(JPEG)  # "{}" header

    def test_a_truncated_message_is_refused(self):
        with pytest.raises(BinaryFrameError, match="too short"):
            parse_binary_message(b"\x01\x01")

    def test_a_header_longer_than_the_message_is_refused(self):
        claimed = bytes([BINARY_PROTOCOL_VERSION, 1]) + (500).to_bytes(2, "big") + b"{}"
        with pytest.raises(BinaryFrameError, match="only"):
            parse_binary_message(claimed)

    def test_another_envelope_version_is_refused(self):
        wrong = bytearray(frame())
        wrong[0] = BINARY_PROTOCOL_VERSION + 1
        with pytest.raises(BinaryFrameError, match="binary protocol version"):
            parse_binary_message(bytes(wrong))

    def test_an_unknown_message_type_is_refused(self):
        wrong = bytearray(frame())
        wrong[1] = 99
        with pytest.raises(BinaryFrameError, match="unknown binary message type"):
            parse_binary_message(bytes(wrong))

    def test_an_oversized_message_is_refused_before_anything_else(self):
        with pytest.raises(BinaryFrameError, match="over the"):
            parse_binary_message(b"\x00" * (MAX_MESSAGE_BYTES + 1))

    def test_an_oversized_header_is_refused(self):
        claimed = (
            bytes([BINARY_PROTOCOL_VERSION, 1])
            + (MAX_HEADER_BYTES + 1).to_bytes(2, "big")
            + b"x" * (MAX_HEADER_BYTES + 1)
        )
        with pytest.raises(BinaryFrameError, match="over"):
            parse_binary_message(claimed)

    def test_a_header_that_is_not_json_is_refused(self):
        broken = bytes([BINARY_PROTOCOL_VERSION, 1]) + (3).to_bytes(2, "big") + b"{{{" + JPEG
        with pytest.raises(BinaryFrameError, match="not valid JSON"):
            parse_binary_message(broken)

    def test_a_header_that_is_not_an_object_is_refused(self):
        payload = b"[1]"
        broken = (
            bytes([BINARY_PROTOCOL_VERSION, 1])
            + len(payload).to_bytes(2, "big")
            + payload
            + JPEG
        )
        with pytest.raises(BinaryFrameError, match="not a JSON object"):
            parse_binary_message(broken)

    def test_a_message_with_no_payload_is_refused(self):
        with pytest.raises(BinaryFrameError, match="no payload"):
            parse_binary_message(encode_binary_message(BinaryMessageType.VISION_FRAME, b""))


class TestAFrameIsNoLongerAJsonEvent:
    def test_json_vision_frame_is_an_unknown_event(self):
        """The old shape must not quietly work: protocol 5 refuses the socket,
        and anything that gets past that lands on the unknown-event error."""
        with pytest.raises(ValueError, match="Unknown event type"):
            parse_event({"type": "vision_frame", "frame": "<base64>"})


def handler() -> ChatSessionHandler:
    h = ChatSessionHandler(MagicMock(), user_id=1)
    h.send_event = AsyncMock()
    return h


class TestTheReceiveLoopTellsThemApart:
    @pytest.mark.asyncio
    async def test_bytes_reach_the_vision_path_and_text_does_not(self):
        h = handler()
        h.websocket.receive = AsyncMock(side_effect=[
            {"type": "websocket.receive", "bytes": frame()},
            {"type": "websocket.disconnect", "code": 1000},
        ])
        with patch.object(h, "_handle_vision_frame", new_callable=AsyncMock) as vision, \
             patch.object(h, "_handle_event", new_callable=AsyncMock) as events:
            with pytest.raises(WebSocketDisconnect):
                await h.run()

        events.assert_not_called()
        vision.assert_awaited_once()
        event = vision.await_args.args[0]
        assert isinstance(event, VisionFrameEvent)
        assert event.frame == JPEG

    @pytest.mark.asyncio
    async def test_text_still_reaches_the_json_dispatch(self):
        h = handler()
        h.websocket.receive = AsyncMock(side_effect=[
            {"type": "websocket.receive", "text": json.dumps({"type": "cancel"})},
            {"type": "websocket.disconnect", "code": 1000},
        ])
        with patch.object(h, "_handle_event", new_callable=AsyncMock) as events, \
             patch.object(h, "_handle_vision_frame", new_callable=AsyncMock) as vision:
            with pytest.raises(WebSocketDisconnect):
                await h.run()

        vision.assert_not_called()
        events.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_a_bad_frame_is_an_error_event_not_a_closed_socket(self):
        """A camera sending nonsense loses its frame, not its conversation."""
        h = handler()
        h.websocket.receive = AsyncMock(side_effect=[
            {"type": "websocket.receive", "bytes": b"\x01"},
            {"type": "websocket.receive", "text": json.dumps({"type": "cancel"})},
            {"type": "websocket.disconnect", "code": 1000},
        ])
        with patch.object(h, "_handle_event", new_callable=AsyncMock) as events:
            with pytest.raises(WebSocketDisconnect):
                await h.run()

        codes = [c.args[0].code for c in h.send_event.call_args_list]
        assert "BAD_BINARY_MESSAGE" in codes
        events.assert_awaited_once(), "the socket kept working after the bad frame"


class TestTheProcessorTakesBytes:
    def test_process_frame_decodes_raw_jpeg(self):
        """No base64 step: the bytes off the wire go straight to cv2."""
        import inspect

        from kurisuassistant.vision.processor import VisionProcessor

        source = inspect.getsource(VisionProcessor.process_frame)
        assert "b64decode" not in source
        assert "frame_bytes" in source
