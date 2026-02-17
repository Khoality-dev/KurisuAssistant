package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.data.model.*
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.http.*

interface KurisuApiService {

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

    // Conversations
    @GET("/conversations")
    suspend fun getConversations(
        @Query("agent_id") agentId: Int? = null,
    ): List<Conversation>

    @GET("/conversations/{id}")
    suspend fun getConversation(
        @Path("id") id: Int,
        @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0,
    ): ConversationDetail

    @DELETE("/conversations/{id}")
    suspend fun deleteConversation(@Path("id") id: Int)

    @POST("/conversations/{id}")
    suspend fun updateConversation(
        @Path("id") id: Int,
        @Body body: Map<String, String>,
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
    suspend fun transcribe(@Body audio: RequestBody): TranscriptionResponse

    // Agents
    @GET("/agents")
    suspend fun listAgents(): List<Agent>

    @GET("/agents/{id}")
    suspend fun getAgent(@Path("id") id: Int): Agent

    @POST("/agents")
    suspend fun createAgent(@Body data: AgentCreate): Agent

    @PATCH("/agents/{id}")
    suspend fun updateAgent(@Path("id") id: Int, @Body data: AgentUpdate): Agent

    @Multipart
    @PATCH("/agents/{id}/avatar")
    suspend fun updateAgentAvatar(
        @Path("id") id: Int,
        @Part avatar: MultipartBody.Part,
    ): Agent

    @DELETE("/agents/{id}")
    suspend fun deleteAgent(@Path("id") id: Int)

    // Tools & MCP
    @GET("/tools")
    suspend fun listTools(): ToolsResponse

    @GET("/mcp-servers")
    suspend fun listMCPServers(): MCPServersResponse

    // Character Assets
    @Multipart
    @POST("/character-assets/upload-base")
    suspend fun uploadCharacterBase(
        @Query("agent_id") agentId: Int,
        @Query("pose_id") poseId: String,
        @Part file: MultipartBody.Part,
    ): UploadBaseResponseDTO

    @Multipart
    @POST("/character-assets/compute-patch")
    suspend fun computeCharacterPatch(
        @Query("agent_id") agentId: Int,
        @Query("pose_id") poseId: String,
        @Query("part") part: String,
        @Query("index") index: Int,
        @Part keyframe: MultipartBody.Part,
    ): ComputePatchResponseDTO

    @Multipart
    @POST("/character-assets/upload-video")
    suspend fun uploadTransitionVideo(
        @Query("agent_id") agentId: Int,
        @Query("edge_id") edgeId: String,
        @Part file: MultipartBody.Part,
    ): UploadVideoResponseDTO

    @POST("/character-assets/{agentId}/migrate-ids")
    suspend fun migrateCharacterIds(
        @Path("agentId") agentId: Int,
        @Body body: Map<String, Map<String, String>>,
    )

    @PATCH("/character-assets/{agentId}/character-config")
    suspend fun updateCharacterConfig(
        @Path("agentId") agentId: Int,
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
