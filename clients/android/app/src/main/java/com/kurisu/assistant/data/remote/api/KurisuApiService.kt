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
    suspend fun getConversations(): List<Conversation>

    @GET("/conversations/{id}")
    suspend fun getConversation(
        @Path("id") id: Int,
        @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0,
    ): ConversationDetail

    @DELETE("/conversations/{id}")
    suspend fun deleteConversation(@Path("id") id: Int)

    /**
     * Rename a conversation — its `title` is all a conversation has to change:
     * it is not tied to a persona (#354). Build the body with
     * [com.kurisu.assistant.data.repository.ConversationRepository].
     */
    @PATCH("/conversations/{id}")
    suspend fun patchConversation(
        @Path("id") id: Int,
        @Body body: JsonObject,
    )

    // Tasks (#352). No create: the assistant plans tasks with its own tools.
    @GET("/tasks")
    suspend fun listTasks(): List<AssistantTask>

    @GET("/tasks/{id}")
    suspend fun getTask(@Path("id") id: Int): AssistantTask

    @PATCH("/tasks/{id}")
    suspend fun updateTask(@Path("id") id: Int, @Body body: TaskUpdate): AssistantTask

    @GET("/tasks/approvals")
    suspend fun listTaskApprovals(): List<TaskApproval>

    @POST("/tasks/approvals/{id}")
    suspend fun answerTaskApproval(@Path("id") id: Int, @Body body: ApprovalAnswer): TaskApproval

    @POST("/tasks/{id}/stop")
    suspend fun stopTask(@Path("id") id: Int): Map<String, Boolean>

    @DELETE("/tasks/{id}")
    suspend fun deleteTask(@Path("id") id: Int): Map<String, String>

    // Kurisu Drive (#175). Nodes are addressed by id; a folder that is not the
    // account's is a 404, never a 403.
    @GET("/drive/usage")
    suspend fun getDriveUsage(): DriveUsage

    /** A folder's children, folders first, then by name. A null [parentId] is the root. */
    @GET("/drive/nodes")
    suspend fun listDriveNodes(@Query("parent_id") parentId: Int?): List<DriveNode>

    @POST("/drive/folders")
    suspend fun createDriveFolder(@Body body: DriveFolderCreate): DriveNode

    /**
     * Rename, move, or both. A JSON object rather than a data class because a
     * left-out `parent_id` keeps the parent and an explicit `null` moves the
     * node to the root.
     */
    @PATCH("/drive/nodes/{id}")
    suspend fun updateDriveNode(@Path("id") id: Int, @Body body: JsonObject): DriveNode

    /** Hard and recursive: the drive has no trash. */
    @DELETE("/drive/nodes/{id}")
    suspend fun deleteDriveNode(@Path("id") id: Int): Map<String, Boolean>

    /** The file is the raw body, not multipart; where it goes is the query. */
    @POST("/drive/files")
    suspend fun uploadDriveFile(
        @Query("name") name: String,
        @Query("parent_id") parentId: Int?,
        @Query("overwrite") overwrite: Boolean,
        @Body body: RequestBody,
    ): DriveNode

    @Streaming
    @GET("/drive/files/{id}/content")
    suspend fun downloadDriveFile(@Path("id") id: Int): ResponseBody

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

    /** Some profile fields, as a raw body: the account's time zone (#352). */
    @PATCH("/users/me")
    suspend fun patchUserProfile(@Body body: JsonObject): Map<String, String>

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

    // There is no `/tts/backends`; the backend lists TTS models here (#200).
    @GET("/tts/models")
    suspend fun listTtsModels(): TtsModelsResponse

    // ASR. `model` is the universal-voice model id from `/asr/models`; absent
    // means the server's default. (`mode` used to be sent and was read by nothing.)
    @POST("/asr")
    suspend fun transcribe(
        @Body audio: RequestBody,
        @retrofit2.http.Query("language") language: String? = null,
        @retrofit2.http.Query("model") model: String? = null,
    ): TranscriptionResponse

    @POST("/asr/detect-language")
    suspend fun detectLanguage(
        @Body audio: RequestBody,
        @retrofit2.http.Query("model") model: String? = null,
    ): LanguageDetectionResponse

    @GET("/asr/models")
    suspend fun listAsrModels(): AsrModelsResponse

    // Assistant — exactly one per user, created at registration, so it is
    // addressed with no id and has no POST and no DELETE.
    @GET("/assistant")
    suspend fun getAssistant(): Assistant

    @PATCH("/assistant")
    suspend fun updateAssistant(@Body data: AssistantUpdate): Assistant

    /** A hand-built body, for the one patch that needs an explicit null. */
    @PATCH("/assistant")
    suspend fun patchAssistant(@Body body: JsonObject): Assistant

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

    // Notifications (#353): the server keeps them and their read state; a read
    // here is announced to every device, which takes it down.
    @GET("/notifications")
    suspend fun listNotifications(
        @Query("unread") unread: Boolean? = null,
        @Query("limit") limit: Int? = null,
        @Query("offset") offset: Int? = null,
    ): NotificationList

    @POST("/notifications/{id}/read")
    suspend fun markNotificationRead(@Path("id") id: Int): NotificationEvent

    @POST("/notifications/read-all")
    suspend fun markAllNotificationsRead(): NotificationReadResult

    // Push to this phone through Firebase Cloud Messaging (#353).
    @POST("/notifications/devices")
    suspend fun registerNotificationDevice(@Body body: DeviceRegistration): DeviceRegistrationResult

    @DELETE("/notifications/devices/{token}")
    suspend fun deleteNotificationDevice(@Path("token") token: String)

    @POST("/notifications/read-for")
    suspend fun markNotificationsReadFor(@Body body: NotificationReadFor): NotificationReadResult

    // Calendar (#282). Instants go as ISO 8601 UTC; an entry of another account is 404.
    @GET("/calendar/entries")
    suspend fun listCalendarEntries(
        @Query("start") start: String,
        @Query("end") end: String,
    ): List<CalendarEntry>

    @GET("/calendar/upcoming")
    suspend fun getUpcomingCalendar(@Query("limit") limit: Int = 20): List<CalendarEntry>

    @GET("/calendar/entries/{id}")
    suspend fun getCalendarEntry(@Path("id") id: Int): CalendarEntry

    @POST("/calendar/entries")
    suspend fun createCalendarEntry(@Body body: CalendarEntryCreate): CalendarEntry

    @PATCH("/calendar/entries/{id}")
    suspend fun updateCalendarEntry(@Path("id") id: Int, @Body body: CalendarEntryUpdate): CalendarEntry

    @DELETE("/calendar/entries/{id}")
    suspend fun deleteCalendarEntry(@Path("id") id: Int)
}
