package com.kurisu.assistant.data.remote.websocket

import okio.Buffer
import okio.ByteString

/**
 * The binary envelope webcam frames travel in.
 *
 * Mirrors `backend/kurisuassistant/websocket/binary.py`. A frame used to be
 * base64 JPEG inside a JSON event on the chat socket, so every frame cost a
 * third extra on the wire, a JSON parse on the server, and — the reason this
 * exists — a place in the send buffer ahead of the assistant's next token (#111).
 *
 * ```
 * 0        1        2                 4              4+H
 * +--------+--------+-----------------+---------------+------------------+
 * | version| type   | header length   | header (JSON) | payload (bytes)  |
 * | uint8  | uint8  | uint16 big-end. | UTF-8, H long | JPEG             |
 * +--------+--------+-----------------+---------------+------------------+
 * ```
 *
 * If a field here disagrees with the backend, the backend wins — fix this file.
 */
object BinaryFrameCodec {

    /** The envelope's own version, not the wire protocol. */
    const val BINARY_PROTOCOL_VERSION = 1

    const val TYPE_VISION_FRAME = 1

    /** version + type + header length. */
    const val HEADER_PREFIX_BYTES = 4

    /** The server refuses anything larger. */
    const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
    const val MAX_HEADER_BYTES = 4096

    /**
     * Build one binary message. [header] is a JSON object carrying what the old
     * event carried besides the image — `event_id` and `timestamp`.
     */
    fun encode(type: Int, payload: ByteArray, header: String = "{}"): ByteString {
        val headerBytes = header.toByteArray(Charsets.UTF_8)
        require(headerBytes.size <= MAX_HEADER_BYTES) {
            "Binary header is ${headerBytes.size} bytes, over $MAX_HEADER_BYTES"
        }

        val buffer = Buffer()
        buffer.writeByte(BINARY_PROTOCOL_VERSION)
        buffer.writeByte(type)
        buffer.writeShort(headerBytes.size) // big-endian, as the server reads it
        buffer.write(headerBytes)
        buffer.write(payload)
        return buffer.readByteString()
    }

    /** A webcam frame, ready for `WebSocket.send`. */
    fun encodeVisionFrame(jpeg: ByteArray, eventId: String, timestamp: String): ByteString =
        encode(
            TYPE_VISION_FRAME,
            jpeg,
            """{"event_id":"$eventId","timestamp":"$timestamp"}""",
        )
}
