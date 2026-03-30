package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Common base for all server-sent WebSocket events (not serialized polymorphically) */
interface ServerEvent {
    val type: String
    val eventId: String
    val timestamp: String
}

@Serializable
data class StreamChunkEvent(
    override val type: String = "stream_chunk",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val content: String = "",
    val thinking: String? = null,
    val role: String = "",
    @SerialName("agent_id") val agentId: Int? = null,
    val name: String? = null,
    @SerialName("persona_name") val personaName: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("provider_type") val providerType: String? = null,
    @SerialName("tool_args") val toolArgs: JsonObject? = null,
    @SerialName("tool_status") val toolStatus: String? = null,
    @SerialName("conversation_id") val conversationId: Int = 0,
    @SerialName("frame_id") val frameId: Int = 0,
    val images: List<String>? = null,
    @SerialName("token_count") val tokenCount: Int? = null,
) : ServerEvent

@Serializable
data class AgentSwitchEvent(
    override val type: String = "agent_switch",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("from_agent_id") val fromAgentId: Int? = null,
    @SerialName("from_agent_name") val fromAgentName: String? = null,
    @SerialName("to_agent_id") val toAgentId: Int? = null,
    @SerialName("to_agent_name") val toAgentName: String? = null,
    val reason: String = "",
) : ServerEvent

@Serializable
data class DoneEvent(
    override val type: String = "done",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("conversation_id") val conversationId: Int = 0,
    @SerialName("frame_id") val frameId: Int = 0,
) : ServerEvent

@Serializable
data class ErrorEvent(
    override val type: String = "error",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val error: String = "",
    val code: String = "",
) : ServerEvent

@Serializable
data class ToolApprovalRequestEvent(
    override val type: String = "tool_approval_request",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("approval_id") val approvalId: String = "",
    @SerialName("tool_name") val toolName: String = "",
    @SerialName("tool_args") val toolArgs: JsonObject = JsonObject(emptyMap()),
    @SerialName("agent_id") val agentId: Int? = null,
    val name: String? = null,
    val description: String = "",
    @SerialName("risk_level") val riskLevel: String = "",
) : ServerEvent

@Serializable
data class VisionResultEvent(
    override val type: String = "vision_result",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val faces: List<VisionFace> = emptyList(),
    val gestures: List<VisionGesture> = emptyList(),
) : ServerEvent

@Serializable
data class MediaStateEvent(
    override val type: String = "media_state",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val state: String = "",
    @SerialName("current_track") val currentTrack: MediaTrack? = null,
    val queue: List<MediaTrack> = emptyList(),
    val volume: Float = 1f,
) : ServerEvent

@Serializable
data class MediaChunkEvent(
    override val type: String = "media_chunk",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val data: String = "",
    @SerialName("chunk_index") val chunkIndex: Int = 0,
    @SerialName("is_last") val isLast: Boolean = false,
    val format: String = "",
    @SerialName("sample_rate") val sampleRate: Int = 0,
) : ServerEvent

@Serializable
data class MediaErrorEvent(
    override val type: String = "media_error",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val error: String = "",
) : ServerEvent

@Serializable
data class ConnectedEvent(
    override val type: String = "connected",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("chat_active") val chatActive: Boolean = false,
    @SerialName("conversation_id") val conversationId: Int? = null,
    @SerialName("frame_id") val frameId: Int? = null,
    @SerialName("media_state") val mediaState: JsonObject? = null,
    @SerialName("vision_active") val visionActive: Boolean = false,
    @SerialName("vision_config") val visionConfig: JsonObject? = null,
) : ServerEvent

@Serializable
data class ContextInfoEvent(
    override val type: String = "context_info",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("conversation_id") val conversationId: Int = 0,
    val compacting: Boolean = false,
    @SerialName("compacted_up_to_id") val compactedUpToId: Int = 0,
    @SerialName("compacted_context") val compactedContext: String = "",
) : ServerEvent
