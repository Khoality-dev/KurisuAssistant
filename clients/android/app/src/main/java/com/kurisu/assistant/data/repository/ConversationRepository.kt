package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.ConversationDetail
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.remote.api.KurisuApiService
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ConversationRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun getConversations(personaId: Int? = null): List<Conversation> =
        api.getConversations(personaId)

    suspend fun getConversation(id: Int, limit: Int = 20, offset: Int = 0): ConversationDetail =
        api.getConversation(id, limit, offset)

    suspend fun deleteConversation(id: Int) = api.deleteConversation(id)

    suspend fun deleteMessage(id: Int) = api.deleteMessage(id)

    suspend fun getMessageRaw(id: Int): MessageRawData = api.getMessageRaw(id)

    suspend fun getLatestConversationForPersona(personaId: Int): Conversation? {
        val conversations = api.getConversations(personaId)
        return conversations.firstOrNull()
    }

    suspend fun renameConversation(id: Int, title: String) =
        api.patchConversation(id, buildJsonObject { put("title", title) })

    /**
     * Bind this conversation to [personaId], or UNBIND it when [personaId] is
     * null so the next message falls back to the assistant's default persona.
     *
     * The body is built by hand because the route distinguishes an absent key
     * ("leave it alone") from an explicit null ("clear it"), which no nullable
     * Kotlin field can express on its own.
     */
    suspend fun setConversationPersona(id: Int, personaId: Int?) {
        val body: JsonObject = buildJsonObject {
            if (personaId != null) put("persona_id", personaId) else put("persona_id", JsonNull)
        }
        api.patchConversation(id, body)
    }
}
