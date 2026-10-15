package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.ConversationDetail
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.remote.api.KurisuApiService
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The user's conversations. A conversation is not tied to a persona (#354): who
 * answers is the persona in use for the whole account, on the assistant row.
 */
@Singleton
class ConversationRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun getConversations(): List<Conversation> = api.getConversations()

    suspend fun getConversation(id: Int, limit: Int = 20, offset: Int = 0): ConversationDetail =
        api.getConversation(id, limit, offset)

    suspend fun deleteConversation(id: Int) = api.deleteConversation(id)

    suspend fun deleteMessage(id: Int) = api.deleteMessage(id)

    suspend fun getMessageRaw(id: Int): MessageRawData = api.getMessageRaw(id)

    suspend fun renameConversation(id: Int, title: String) =
        api.patchConversation(id, buildJsonObject { put("title", title) })
}
