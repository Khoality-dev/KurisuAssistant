"""Binary WebSocket messages: pixels that must not queue behind a token.

A webcam frame used to travel as base64 JPEG inside a JSON event on the same
socket as the chat stream (#111). Three costs, all paid per frame: the assistant's
next token waited behind a few hundred kilobytes in the send buffer, base64 added
a third to every one of them, and the server parsed a JSON document before it had
even looked at the payload.

Frames are now WebSocket **binary** messages. The envelope is fixed-size and the
pixels are a slice of the received buffer, so the only per-frame parsing is a
4-byte header plus a small JSON object that carries what the old event carried
besides the image::

    0        1        2                 4              4+H
    +--------+--------+-----------------+---------------+------------------+
    | version| type   | header length   | header (JSON) | payload (bytes)  |
    | uint8  | uint8  | uint16 big-end. | UTF-8, H long | JPEG             |
    +--------+--------+-----------------+---------------+------------------+

`version` is this module's `BINARY_PROTOCOL_VERSION`, not the wire protocol: the
wire protocol gates the whole connection at the handshake, while this byte lets a
future message type be added or reshaped without another connection-wide bump.

Nothing here trusts its input. Every rejection is a `BinaryFrameError`, which the
session turns into an ordinary `error` event and keeps the socket open — a bad
frame from a camera is not a reason to drop a conversation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import IntEnum

# Bumped when this envelope changes shape. Independent of the wire protocol.
BINARY_PROTOCOL_VERSION = 1

# The fixed part: version, type, and the header's length.
HEADER_PREFIX_BYTES = 4

# A 640x480 JPEG at quality 0.7 is tens of kilobytes; this is room for a much
# larger camera without letting one message consume the process.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024

# The JSON header carries ids and timestamps, never payload data.
MAX_HEADER_BYTES = 4096


class BinaryMessageType(IntEnum):
    """What the payload after the header is."""

    VISION_FRAME = 1


class BinaryFrameError(ValueError):
    """A binary message that cannot be trusted to be what it claims."""


@dataclass(frozen=True)
class BinaryMessage:
    """A parsed binary message: its type, its JSON header, and its raw payload."""

    type: BinaryMessageType
    header: dict
    payload: bytes


def encode_binary_message(
    message_type: BinaryMessageType,
    payload: bytes,
    header: dict | None = None,
) -> bytes:
    """Build a binary message. The clients encode the same layout by hand."""
    header_bytes = json.dumps(header or {}, separators=(",", ":")).encode("utf-8")
    if len(header_bytes) > MAX_HEADER_BYTES:
        raise BinaryFrameError(f"header is {len(header_bytes)} bytes, over {MAX_HEADER_BYTES}")
    return (
        bytes([BINARY_PROTOCOL_VERSION, int(message_type)])
        + len(header_bytes).to_bytes(2, "big")
        + header_bytes
        + payload
    )


def parse_binary_message(data: bytes) -> BinaryMessage:
    """Parse one binary message, or say precisely why it is not one.

    Raises:
        BinaryFrameError: truncated, over-long, an unknown envelope version or
            message type, or a header that is not a JSON object.
    """
    if len(data) > MAX_MESSAGE_BYTES:
        raise BinaryFrameError(f"message is {len(data)} bytes, over the {MAX_MESSAGE_BYTES} limit")
    if len(data) < HEADER_PREFIX_BYTES:
        raise BinaryFrameError(f"message is {len(data)} bytes, too short to carry a header")

    version = data[0]
    if version != BINARY_PROTOCOL_VERSION:
        raise BinaryFrameError(
            f"binary protocol version {version}, this server speaks {BINARY_PROTOCOL_VERSION}"
        )

    try:
        message_type = BinaryMessageType(data[1])
    except ValueError:
        raise BinaryFrameError(f"unknown binary message type {data[1]}") from None

    header_length = int.from_bytes(data[2:4], "big")
    if header_length > MAX_HEADER_BYTES:
        raise BinaryFrameError(f"header claims {header_length} bytes, over {MAX_HEADER_BYTES}")

    header_end = HEADER_PREFIX_BYTES + header_length
    if len(data) < header_end:
        raise BinaryFrameError(
            f"header claims {header_length} bytes but only {len(data) - HEADER_PREFIX_BYTES} follow"
        )

    raw_header = data[HEADER_PREFIX_BYTES:header_end]
    if raw_header:
        try:
            header = json.loads(raw_header.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise BinaryFrameError(f"header is not valid JSON: {e}") from None
        if not isinstance(header, dict):
            raise BinaryFrameError("header is not a JSON object")
    else:
        header = {}

    payload = data[header_end:]
    if not payload:
        raise BinaryFrameError("message carries a header but no payload")

    return BinaryMessage(type=message_type, header=header, payload=payload)
