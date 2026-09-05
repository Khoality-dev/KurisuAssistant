package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.data.model.*
import kotlinx.serialization.json.JsonObject
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.http.*

interface KurisuApiService {

    // Version handshake
    @GET("/version")
    suspend fun getServerVersion(): ServerVersionInfo

    // Auth
    @Multipart
    @POST("/login")
    suspend fun login(
        @Part("username") username: RequestBody,
        @Part("password") password: RequestBody,
    ): LoginResponse

    @Multipart
    @POST("/register")
    suspend fun register(
        @Part("username") username: RequestBody,
        @Part("password") password: RequestBody,
        @Part("email") email: RequestBody? = null,
    ): LoginResponse

    @POST("/auth/refresh")
    suspend fun refreshToken(@Body body: Map<String, String>): LoginResponse

    // API Key Validation
    @POST("/models/validate-key")
    suspend fun validateApiKey(@Body body: Map<String, String>): Map<String, @JvmSuppressWildcards Any>

    // Conversations
    @GET("/conversations")
    suspend fun getConversations(
        @Query("persona_id") personaId: Int? = null,
    ): List<Conversation>

    @GET("/conversations/{id}")
    suspend fun getConversation(
        @Path("id") id: Int,
        @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0,
    ): ConversationDetail

    @DELETE("/conversations/{id}")
    suspend fun deleteConversation(@Path("id") id: Int)

    /**
     * Rename a conversation, rebind its persona, or both. Replaces the old
     * `POST /conversations/{id}`, which only ever renamed.
     *
     * The body is a raw [JsonObject] because this route reads it through
     * `model_fields_set`: an ABSENT key is left alone, while an explicit
     * `"persona_id": null` UNBINDS the conversation so the next message falls
     * back to the assistant's default persona. A typed DTO cannot tell those two
     * apart. Build the body with [com.kurisu.assistant.data.repository.ConversationRepository].
     */
    @PATCH("/conversations/{id}")
    suspend fun patchConversation(
        @Path("id") id: Int,
        @Body body: JsonObject,
    )

    // Messages
    @DELETE("/messages/{id}")
    suspend fun deleteMessage(@Path("id") id: Int): Map<String, Int>

    @GET("/messages/{id}/raw")
    suspend fun getMessageRaw(@Path("id") id: Int): MessageRawData

    // Models
    @GET("/models")
    suspend fun getModels(): ModelsResponse

    // User Profile
    @GET("/users/me")
    suspend fun getUserProfile(): UserProfile

    @PATCH("/users/me")
    suspend fun updateUserProfile(@Body profile: UserProfile): UserProfile

    @Multipart
    @PATCH("/users/me/avatars")
    suspend fun updateUserAvatars(
        @Part userAvatar: MultipartBody.Part? = null,
        @Part agentAvatar: MultipartBody.Part? = null,
    ): UserProfile

    // Images
    @Multipart
    @POST("/images")
    suspend fun uploadImage(@Part file: MultipartBody.Part): ImageUploadResponse

    // TTS
    @POST("/tts")
    suspend fun synthesize(@Body request: TTSRequest): ResponseBody

    @GET("/tts/voices")
    suspend fun listVoices(@Query("provider") provider: String? = null): VoicesResponse

    @GET("/tts/backends")
    suspend fun listBackends(): BackendsResponse

    // ASR
    @POST("/asr")
    suspend fun transcribe(
        @Body audio: RequestBody,
        @retrofit2.http.Query("language") language: String? = null,
        @retrofit2.http.Query("mode") mode: String? = null,
    ): TranscriptionResponse

    @GET("/asr/models")
    suspend fun listAsrModels(): AsrModelsResponse

    // Assistant — exactly one per user, created at registration, so it is
    // addressed with no id and has no POST and no DELETE.
    @GET("/assistant")
    suspend fun getAssistant(): Assistant

    @PATCH("/assistant")
    suspend fun updateAssistant(@Body data: AssistantUpdate): Assistant

    // Personas — presentation. `/agents` is gone and is NOT aliased.
    @GET("/personas")
    suspend fun listPersonas(): List<Persona>

    @GET("/personas/{id}")
    suspend fun getPersona(@Path("id") id: Int): Persona

    @POST("/personas")
    suspend fun createPersona(@Body data: PersonaCreate): Persona

    @PATCH("/personas/{id}")
    suspend fun updatePersona(@Path("id") id: Int, @Body data: PersonaUpdate): Persona

    @DELETE("/personas/{id}")
    suspend fun deletePersona(@Path("id") id: Int)

    @PATCH("/personas/{id}/enabled")
    suspend fun setPersonaEnabled(@Path("id") id: Int, @Body body: EnabledUpdate): Persona

    @GET("/personas/{id}/export")
    suspend fun exportPersona(@Path("id") id: Int): ResponseBody

    @Multipart
    @POST("/personas/import")
    suspend fun importPersona(@Part file: MultipartBody.Part): Persona

    // Sub-agents — task-only workers. No identity, no memory.
    @GET("/sub-agents")
    suspend fun listSubAgents(): List<SubAgent>

    @GET("/sub-agents/{id}")
    suspend fun getSubAgent(@Path("id") id: Int): SubAgent

    @POST("/sub-agents")
    suspend fun createSubAgent(@Body data: SubAgentCreate): SubAgent

    @PATCH("/sub-agents/{id}")
    suspend fun updateSubAgent(@Path("id") id: Int, @Body data: SubAgentUpdate): SubAgent

    @DELETE("/sub-agents/{id}")
    suspend fun deleteSubAgent(@Path("id") id: Int)

    @PATCH("/sub-agents/{id}/enabled")
    suspend fun setSubAgentEnabled(@Path("id") id: Int, @Body body: EnabledUpdate): SubAgent

    @GET("/sub-agents/{id}/export")
    suspend fun exportSubAgent(@Path("id") id: Int): ResponseBody

    @Multipart
    @POST("/sub-agents/import")
    suspend fun importSubAgent(@Part file: MultipartBody.Part): SubAgent

    // Tools & MCP
    @GET("/tools")
    suspend fun listTools(): ToolsResponse

    @GET("/mcp-servers")
    suspend fun listMCPServers(): List<MCPServer>

    @POST("/mcp-servers")
    suspend fun createMCPServer(@Body data: MCPServerCreate): MCPServer

    @PATCH("/mcp-servers/{id}")
    suspend fun updateMCPServer(@Path("id") id: Int, @Body data: MCPServerUpdate): MCPServer

    @DELETE("/mcp-servers/{id}")
    suspend fun deleteMCPServer(@Path("id") id: Int)

    @POST("/mcp-servers/{id}/test")
    suspend fun testMCPServer(@Path("id") id: Int): MCPServerTestResult

    // Character Assets
    @Multipart
    @POST("/character-assets/upload-base")
    suspend fun uploadCharacterBase(
        @Query("persona_id") personaId: Int,
        @Query("pose_id") poseId: String,
        @Part file: MultipartBody.Part,
    ): UploadBaseResponseDTO

    @Multipart
    @POST("/character-assets/compute-patch")
    suspend fun computeCharacterPatch(
        @Query("persona_id") personaId: Int,
        @Query("pose_id") poseId: String,
        @Query("part") part: String,
        @Query("index") index: Int,
        @Part keyframe: MultipartBody.Part,
    ): ComputePatchResponseDTO

    @Multipart
    @POST("/character-assets/upload-video")
    suspend fun uploadTransitionVideo(
        @Query("persona_id") personaId: Int,
        @Query("edge_id") edgeId: String,
        @Part file: MultipartBody.Part,
    ): UploadVideoResponseDTO

    @POST("/character-assets/{personaId}/migrate-ids")
    suspend fun migrateCharacterIds(
        @Path("personaId") personaId: Int,
        @Body body: Map<String, Map<String, String>>,
    )

    @PATCH("/character-assets/{personaId}/character-config")
    suspend fun updateCharacterConfig(
        @Path("personaId") personaId: Int,
        @Body config: Map<String, @JvmSuppressWildcards Any>,
    )

    // Face Recognition
    @GET("/faces")
    suspend fun listFaces(): List<FaceIdentity>

    @Multipart
    @POST("/faces")
    suspend fun createFace(
        @Query("name") name: String,
        @Part photo: MultipartBody.Part,
    ): FaceIdentity

    @GET("/faces/{id}")
    suspend fun getFace(@Path("id") id: Int): FaceIdentityDetail

    @DELETE("/faces/{id}")
    suspend fun deleteFace(@Path("id") id: Int)

    @Multipart
    @POST("/faces/{id}/photos")
    suspend fun addFacePhoto(
        @Path("id") id: Int,
        @Part photo: MultipartBody.Part,
    ): FacePhoto

    @DELETE("/faces/{identityId}/photos/{photoId}")
    suspend fun deleteFacePhoto(
        @Path("identityId") identityId: Int,
        @Path("photoId") photoId: Int,
    )

    // Skills
    @GET("/skills")
    suspend fun listSkills(): List<Skill>

    @POST("/skills")
    suspend fun createSkill(@Body data: SkillCreate): Skill

    @PATCH("/skills/{id}")
    suspend fun updateSkill(@Path("id") id: Int, @Body data: SkillUpdate): Skill

    @DELETE("/skills/{id}")
    suspend fun deleteSkill(@Path("id") id: Int)
}
