package com.kurisu.assistant.data.remote.websocket

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Client → Server events (sent as JSON over WS) */

@Serializable
data class ChatRequestPayload(
    val type: String = "chat_request",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    val text: String,
    @SerialName("model_name") val modelName: String,
    @SerialName("conversation_id") val conversationId: Int? = null,
    // Optional per-turn persona override. Omit on an ordinary message: a new
    // conversation silently adopts the assistant's default persona and an
    // existing one keeps its binding. Sending it REBINDS the conversation.
    // The old `agent_id` was renamed, not aliased — the backend ignores it.
    @SerialName("persona_id") val personaId: Int? = null,
    val images: List<String> = emptyList(),
)

@Serializable
data class CancelPayload(
    val type: String = "cancel",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
)

@Serializable
data class VisionStartPayload(
    val type: String = "vision_start",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    @SerialName("enable_face") val enableFace: Boolean = true,
    @SerialName("enable_pose") val enablePose: Boolean = true,
    @SerialName("enable_hands") val enableHands: Boolean = true,
)

@Serializable
data class VisionFramePayload(
    val type: String = "vision_frame",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    val frame: String,
)

@Serializable
data class VisionStopPayload(
    val type: String = "vision_stop",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
)

@Serializable
data class ToolApprovalResponsePayload(
    val type: String = "tool_approval_response",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    @SerialName("approval_id") val approvalId: String,
    val approved: Boolean,
)

@Serializable
data class CompactContextPayload(
    val type: String = "compact_context",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    @SerialName("conversation_id") val conversationId: Int,
)

/**
 * Answer to a `tool_call_request`. Backend keys it by [requestId]; when [isError] is
 * true the content is surfaced to the model as "Client tool error: <content>".
 */
@Serializable
data class ToolCallResponsePayload(
    val type: String = "tool_call_response",
    @SerialName("event_id") val eventId: String,
    val timestamp: String,
    @SerialName("request_id") val requestId: String,
    val content: String,
    @SerialName("is_error") val isError: Boolean = false,
)
