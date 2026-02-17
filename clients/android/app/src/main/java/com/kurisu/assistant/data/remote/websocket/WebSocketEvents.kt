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
    @SerialName("agent_id") val agentId: Int? = null,
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
