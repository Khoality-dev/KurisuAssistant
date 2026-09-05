package com.kurisu.assistant.data.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

@Serializable
data class LoginResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("token_type") val tokenType: String,
)

/**
 * The persona stamped on a stored message — who said it, as they looked at the
 * time. Mirrors the `persona` object the backend nests inside a message
 * (`routers/conversations.py::get_conversation`): id, name, avatar and voice only.
 * A persona owns no model, no tools and no memory; that is the assistant's half.
 */
@Serializable
data class MessagePersona(
    val id: Int,
    val name: String,
    @SerialName("avatar_uuid") val avatarUuid: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
)

@Serializable
data class Message(
    val id: Int? = null,
    val role: String,
    val content: String,
    val thinking: String? = null,
    val images: List<String>? = null,
    @SerialName("frame_id") val frameId: Int? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("persona_id") val personaId: Int? = null,
    val name: String? = null,
    val persona: MessagePersona? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("has_raw_data") val hasRawData: Boolean? = null,
    @SerialName("persona_name") val personaName: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("provider_type") val providerType: String? = null,
    @SerialName("tool_args") val toolArgs: JsonObject? = null,
    @SerialName("tool_status") val toolStatus: String? = null,
    // Tool-rail metadata. Live only for the duration of a stream: the backend
    // sends them on `stream_chunk` and does not persist them, so a reloaded
    // transcript has them null and the rail simply omits the tag and the timing.
    @SerialName("tool_kind") val toolKind: String? = null,   // "tool" | "sub_agent"
    @SerialName("duration_ms") val durationMs: Int? = null,
    @SerialName("context_files") val contextFiles: JsonArray? = null,
    val queued: Boolean? = null,
)

@Serializable
data class ConversationLastMessage(
    val content: String,
    val role: String,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class Conversation(
    val id: Int,
    val title: String = "",
    @SerialName("frame_count") val frameCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
    @SerialName("last_message") val lastMessage: ConversationLastMessage? = null,
    // The persona bound to this conversation. The backend has always sent it and
    // this client used to drop it on the floor, which is why a conversation row
    // could not show who answers it. Null means unbound: the next message adopts
    // the assistant's default persona.
    @SerialName("persona_id") val personaId: Int? = null,
)

@Serializable
data class FrameInfo(
    val id: Int,
    val summary: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class ConversationDetail(
    val id: Int,
    val title: String,
    @SerialName("created_at") val createdAt: String,
    val messages: List<Message>,
    val frames: Map<String, FrameInfo> = emptyMap(),
    @SerialName("total_messages") val totalMessages: Int,
    val offset: Int,
    val limit: Int,
    @SerialName("has_more") val hasMore: Boolean,
    @SerialName("compacted_up_to_id") val compactedUpToId: Int = 0,
    @SerialName("compacted_context") val compactedContext: String = "",
    @SerialName("system_prompt_token_count") val systemPromptTokenCount: Int = 0,
    // Who is answering in this conversation — the chat header's current persona.
    // Null means unbound; the next message adopts the assistant's default.
    @SerialName("persona_id") val personaId: Int? = null,
)

@Serializable
data class UserProfile(
    val username: String,
    val email: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @SerialName("preferred_name") val preferredName: String? = null,
    @SerialName("user_avatar_uuid") val userAvatarUuid: String? = null,
    @SerialName("agent_avatar_uuid") val agentAvatarUuid: String? = null,
    @SerialName("assistant_avatar_uuid") val assistantAvatarUuid: String? = null,
    @SerialName("ollama_url") val ollamaUrl: String? = null,
    @SerialName("summary_model") val summaryModel: String? = null,
    // Provider keys are write-only: the server reports only whether one is set,
    // and these carry a new key on PATCH. Null means "leave the stored key alone".
    @SerialName("has_gemini_key") val hasGeminiKey: Boolean = false,
    @SerialName("has_nvidia_key") val hasNvidiaKey: Boolean = false,
    @SerialName("gemini_api_key") val geminiApiKey: String? = null,
    @SerialName("nvidia_api_key") val nvidiaApiKey: String? = null,
    @SerialName("context_size") val contextSize: Int? = null,
)

@Serializable
data class VoicesResponse(val voices: List<String>)

@Serializable
data class BackendsResponse(val backends: List<String>)

@Serializable
data class TTSRequest(
    val text: String,
    val voice: String? = null,
    val language: String? = null,
    val provider: String? = null,
    @SerialName("emo_audio") val emoAudio: String? = null,
    @SerialName("emo_alpha") val emoAlpha: Float? = null,
    @SerialName("use_emo_text") val useEmoText: Boolean? = null,
)

// ─── The assistant / persona / sub-agent split (wire protocol 4) ───────────
//
// The old `Agent` was one row doing three jobs. It is now three types:
//
//   Assistant — ONE per user, addressed with no id (`GET|PATCH /assistant`).
//               Owns capability: model, provider, tools, reasoning, memory, the
//               voice wake word, and which persona answers by default.
//   Persona   — MANY per user. Owns presentation only: name, prompt, voice, face.
//               No model, no tools, no memory, no trigger word.
//   SubAgent  — MANY per user. A task-only worker the assistant delegates to.
//               Its own model and tools, but no identity and no memory.
//
// PATCH bodies are read server-side through `model_fields_set`, so an omitted
// field is left alone while an explicit null CLEARS the column — and several
// columns reject null outright. `@EncodeDefault(NEVER)` is what keeps those two
// apart here: a field left at its `null` default is not serialized at all, so a
// partial update stays partial instead of blanking every field it did not set.

@Serializable
data class Assistant(
    val id: Int,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("provider_type") val providerType: String = "ollama",
    // null means "every tool" — an empty list means "no tools".
    @SerialName("available_tools") val availableTools: List<String>? = null,
    val think: Boolean = false,
    @SerialName("use_deferred_tools") val useDeferredTools: Boolean = false,
    val memory: String? = null,
    @SerialName("memory_enabled") val memoryEnabled: Boolean = true,
    // A voice WAKE word, not a router: saying it wakes the assistant, and the
    // conversation's bound persona answers. It selects no one.
    @SerialName("trigger_word") val triggerWord: String? = null,
    @SerialName("default_persona_id") val defaultPersonaId: Int? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class AssistantUpdate(
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("model_name") val modelName: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("provider_type") val providerType: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("available_tools") val availableTools: List<String>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val think: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("use_deferred_tools") val useDeferredTools: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val memory: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("memory_enabled") val memoryEnabled: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("trigger_word") val triggerWord: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("default_persona_id") val defaultPersonaId: Int? = null,
)

@Serializable
data class Persona(
    val id: Int,
    val name: String,
    val description: String = "",
    @SerialName("system_prompt") val systemPrompt: String = "",
    @SerialName("preferred_name") val preferredName: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("avatar_uuid") val avatarUuid: String? = null,
    @SerialName("character_config") val characterConfig: JsonObject? = null,
    val enabled: Boolean = true,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PersonaCreate(
    val name: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val description: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("preferred_name") val preferredName: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("voice_reference") val voiceReference: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("avatar_uuid") val avatarUuid: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("character_config") val characterConfig: JsonObject? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val enabled: Boolean? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PersonaUpdate(
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val name: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val description: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("preferred_name") val preferredName: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("voice_reference") val voiceReference: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("avatar_uuid") val avatarUuid: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("character_config") val characterConfig: JsonObject? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val enabled: Boolean? = null,
)

@Serializable
data class SubAgent(
    val id: Int,
    val name: String,
    val description: String = "",
    @SerialName("system_prompt") val systemPrompt: String = "",
    // null means "the assistant's model".
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("provider_type") val providerType: String = "ollama",
    // null means "every tool".
    @SerialName("available_tools") val availableTools: List<String>? = null,
    val think: Boolean = false,
    @SerialName("use_deferred_tools") val useDeferredTools: Boolean = false,
    val enabled: Boolean = true,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SubAgentCreate(
    val name: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val description: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("model_name") val modelName: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("provider_type") val providerType: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("available_tools") val availableTools: List<String>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val think: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("use_deferred_tools") val useDeferredTools: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val enabled: Boolean? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class SubAgentUpdate(
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val name: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val description: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("model_name") val modelName: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("provider_type") val providerType: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("available_tools") val availableTools: List<String>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val think: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    @SerialName("use_deferred_tools") val useDeferredTools: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val enabled: Boolean? = null,
)

/** Body for `PATCH /personas/{id}/enabled` and `PATCH /sub-agents/{id}/enabled`. */
@Serializable
data class EnabledUpdate(val enabled: Boolean)

@Serializable
data class PatchResultDTO(
    @SerialName("image_url") val imageUrl: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

@Serializable
data class UploadBaseResponseDTO(
    @SerialName("asset_id") val assetId: String,
    @SerialName("image_url") val imageUrl: String,
)

@Serializable
data class ComputePatchResponseDTO(
    val patch: PatchResultDTO,
)

@Serializable
data class UploadVideoResponseDTO(
    @SerialName("asset_id") val assetId: String,
    @SerialName("video_url") val videoUrl: String,
)

@Serializable
data class MCPServer(
    val id: Int,
    val name: String,
    @SerialName("transport_type") val transportType: String,
    val url: String? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val enabled: Boolean = true,
    val location: String = "server",
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class MCPServerCreate(
    val name: String,
    @SerialName("transport_type") val transportType: String,
    val url: String? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val location: String? = null,
)

@Serializable
data class MCPServerUpdate(
    val name: String? = null,
    @SerialName("transport_type") val transportType: String? = null,
    val url: String? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val enabled: Boolean? = null,
    val location: String? = null,
)

@Serializable
data class MCPServerTestResult(
    val status: String,
    @SerialName("tool_count") val toolCount: Int? = null,
    val error: String? = null,
)

@Serializable
data class ToolFunction(
    val name: String,
    val description: String,
    val parameters: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class Tool(
    val type: String,
    val function: ToolFunction,
    @SerialName("built_in") val builtIn: Boolean? = null,
)

@Serializable
data class ToolsResponse(
    @SerialName("mcp_tools") val mcpTools: List<Tool>,
    @SerialName("builtin_tools") val builtinTools: List<Tool>,
    @SerialName("mcp_servers") val mcpServers: Map<String, List<Tool>>? = null,
)

@Serializable
data class Skill(
    val id: Int,
    val name: String,
    val instructions: String,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class SkillCreate(
    val name: String,
    val instructions: String? = null,
)

@Serializable
data class SkillUpdate(
    val name: String? = null,
    val instructions: String? = null,
)

@Serializable
data class FaceIdentity(
    val id: Int,
    val name: String,
    @SerialName("photo_count") val photoCount: Int,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class FaceIdentityDetail(
    val id: Int,
    val name: String,
    @SerialName("created_at") val createdAt: String,
    val photos: List<FacePhoto>,
)

@Serializable
data class FacePhoto(
    val id: Int,
    @SerialName("photo_uuid") val photoUuid: String,
    val url: String,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class VisionFace(
    @SerialName("identity_id") val identityId: Int? = null,
    val name: String,
    val confidence: Float,
    val bbox: List<Float>,
)

@Serializable
data class VisionGesture(
    val gesture: String,
    val confidence: Float,
)

@Serializable
data class VisionResult(
    val faces: List<VisionFace>,
    val gestures: List<VisionGesture>,
)

@Serializable
data class MessageRawData(
    val id: Int,
    @SerialName("raw_input") val rawInput: JsonArray? = null,
    @SerialName("raw_output") val rawOutput: String? = null,
)

@Serializable
data class ModelInfo(val name: String, val provider: String = "ollama")

@Serializable
data class ModelsResponse(val models: List<ModelInfo>)

@Serializable
data class AsrModelInfo(
    val id: String,
    val name: String,
    @SerialName("size_mb") val sizeMb: Float? = null,
    val loaded: Boolean = false,
)

@Serializable
data class AsrModelsResponse(
    val data: List<AsrModelInfo> = emptyList(),
)

@Serializable
data class AsrLanguageModelEntry(
    val language: String,
    val model: String,
)

@Serializable
data class TranscriptionResponse(val text: String, val language: String = "")

@Serializable
data class ImageUploadResponse(
    @SerialName("image_uuid") val imageUuid: String,
    val url: String,
)

@Serializable
data class AvatarCandidate(
    val uuid: String,
    @SerialName("pose_id") val poseId: String,
    val score: Float,
)
