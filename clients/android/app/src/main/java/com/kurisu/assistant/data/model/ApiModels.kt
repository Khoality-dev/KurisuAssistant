package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

@Serializable
data class LoginResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String,
)

@Serializable
data class MessageAgent(
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
    @SerialName("agent_id") val agentId: Int? = null,
    val name: String? = null,
    val agent: MessageAgent? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("has_raw_data") val hasRawData: Boolean? = null,
)

@Serializable
data class Conversation(
    val id: Int,
    val title: String = "",
    @SerialName("frame_count") val frameCount: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
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

@Serializable
data class Agent(
    val id: Int,
    val name: String,
    @SerialName("system_prompt") val systemPrompt: String,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("avatar_uuid") val avatarUuid: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    val tools: List<String>? = null,
    val think: Boolean = false,
    @SerialName("character_config") val characterConfig: JsonObject? = null,
    val memory: String? = null,
    @SerialName("trigger_word") val triggerWord: String? = null,
)

@Serializable
data class AgentCreate(
    val name: String,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("model_name") val modelName: String,
    val tools: List<String>? = null,
    val think: Boolean? = null,
    @SerialName("trigger_word") val triggerWord: String? = null,
)

@Serializable
data class AgentUpdate(
    val name: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @SerialName("voice_reference") val voiceReference: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    val tools: List<String>? = null,
    val think: Boolean? = null,
    val memory: String? = null,
    @SerialName("trigger_word") val triggerWord: String? = null,
)

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
    val name: String,
    val command: String,
    val args: List<String>,
    val url: String,
    val status: String,
)

@Serializable
data class MCPServersResponse(val servers: List<MCPServer>)

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
data class MediaTrack(
    val title: String,
    val url: String,
    val duration: Float? = null,
    val thumbnail: String? = null,
    val artist: String? = null,
)

@Serializable
data class MessageRawData(
    val id: Int,
    @SerialName("raw_input") val rawInput: JsonArray? = null,
    @SerialName("raw_output") val rawOutput: String? = null,
)

@Serializable
data class ModelsResponse(val models: List<String>)

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
