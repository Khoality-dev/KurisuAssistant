package com.kurisu.assistant.data.remote.websocket

/**
 * Every WebSocket event name this client uses, in one place.
 *
 * These were retyped by hand from the backend's `websocket/events.py` and the
 * copies drifted with nothing to catch it (#93). The names live here now, the
 * parser and the outgoing events read them from here, and
 * `ProtocolEventsTest` compares this object against `protocol/events.json`,
 * which the backend generates — so a divergence fails this module's own CI job.
 *
 * `vision_frame` is deliberately absent: a webcam frame is a binary message
 * with its own envelope and never travels as JSON (#111).
 */
object ProtocolEvents {
    // Client -> Server
    const val CHAT_REQUEST = "chat_request"
    const val TOOL_APPROVAL_RESPONSE = "tool_approval_response"
    const val CANCEL = "cancel"
    const val VISION_START = "vision_start"
    const val VISION_STOP = "vision_stop"
    const val CLIENT_TOOLS_REGISTER = "client_tools_register"
    const val TOOL_CALL_RESPONSE = "tool_call_response"
    const val COMPACT_CONTEXT = "compact_context"

    // Server -> Client
    const val CONNECTED = "connected"
    const val STREAM_CHUNK = "stream_chunk"
    const val TOOL_APPROVAL_REQUEST = "tool_approval_request"
    const val TOOL_CALL_REQUEST = "tool_call_request"
    const val DONE = "done"
    const val ERROR = "error"
    const val VISION_RESULT = "vision_result"
    const val CONTEXT_INFO = "context_info"

    val CLIENT_TO_SERVER = setOf(
        CHAT_REQUEST,
        TOOL_APPROVAL_RESPONSE,
        CANCEL,
        VISION_START,
        VISION_STOP,
        CLIENT_TOOLS_REGISTER,
        TOOL_CALL_RESPONSE,
        COMPACT_CONTEXT,
    )

    val SERVER_TO_CLIENT = setOf(
        CONNECTED,
        STREAM_CHUNK,
        TOOL_APPROVAL_REQUEST,
        TOOL_CALL_REQUEST,
        DONE,
        ERROR,
        VISION_RESULT,
        CONTEXT_INFO,
    )
}
