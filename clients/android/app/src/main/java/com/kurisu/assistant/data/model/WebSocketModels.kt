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
    // Who is speaking. Set on ASSISTANT chunks only — a tool chunk is not the
    // persona talking, so both are null there and [name] carries the tool label.
    @SerialName("persona_id") val personaId: Int? = null,
    val name: String? = null,
    @SerialName("persona_name") val personaName: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("provider_type") val providerType: String? = null,
    @SerialName("tool_args") val toolArgs: JsonObject? = null,
    @SerialName("tool_status") val toolStatus: String? = null,
    // Tool-chunk metadata, and the ONLY source for either. The chunk is emitted
    // after the call returns, so a client can neither time the call nor tell a
    // delegation from an ordinary tool call on its own.
    @SerialName("tool_kind") val toolKind: String? = null,   // "tool" | "sub_agent"
    @SerialName("duration_ms") val durationMs: Int? = null,
    @SerialName("conversation_id") val conversationId: Int = 0,
    @SerialName("frame_id") val frameId: Int = 0,
    val images: List<String>? = null,
    @SerialName("token_count") val tokenCount: Int? = null,
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
    // Deliberately still `agent_id`: the requester may be a persona OR a
    // sub-agent, so this is not the same identifier as `persona_id` elsewhere.
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
data class ConnectedEvent(
    override val type: String = "connected",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("chat_active") val chatActive: Boolean = false,
    @SerialName("conversation_id") val conversationId: Int? = null,
    // The persona bound to [conversationId], so a reconnecting client knows who
    // is talking before the first chunk arrives.
    @SerialName("persona_id") val personaId: Int? = null,
    @SerialName("frame_id") val frameId: Int? = null,
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

/**
 * Compaction (manual `/compact` or automatic) moved the chat to a NEW conversation
 * seeded with the rolling summary. The client must adopt [newConversationId] or it
 * keeps talking to a conversation the server has already left behind.
 *
 * Mirrors `ConversationSwitchedEvent` in backend/kurisuassistant/websocket/events.py.
 */
@Serializable
data class ConversationSwitchedEvent(
    override val type: String = "conversation_switched",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("old_conversation_id") val oldConversationId: Int = 0,
    @SerialName("new_conversation_id") val newConversationId: Int = 0,
    @SerialName("compacted_context") val compactedContext: String = "",
    // The persona carried over to the new conversation. Without it a compacted
    // conversation loses its voice.
    @SerialName("persona_id") val personaId: Int = 0,
) : ServerEvent

/**
 * Server asks the client to run one of ITS OWN registered tools.
 *
 * Android registers no client tools, but backend session handlers are cached per user
 * and reused across reconnects, so a list registered by the desktop client can outlive
 * that socket and route a call here. Unanswered, the backend blocks for its full 120s
 * timeout per call — so this event exists purely so we can refuse it immediately.
 *
 * Mirrors `ToolCallRequestEvent` in backend/kurisuassistant/websocket/events.py.
 */
@Serializable
data class ToolCallRequestEvent(
    override val type: String = "tool_call_request",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    @SerialName("request_id") val requestId: String = "",
    @SerialName("tool_name") val toolName: String = "",
    @SerialName("tool_args") val toolArgs: JsonObject = JsonObject(emptyMap()),
) : ServerEvent
