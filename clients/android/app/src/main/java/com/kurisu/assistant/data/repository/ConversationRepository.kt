package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.ConversationDetail
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ConversationRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun getConversations(agentId: Int? = null): List<Conversation> =
        api.getConversations(agentId)

    suspend fun getConversation(id: Int, limit: Int = 20, offset: Int = 0): ConversationDetail =
        api.getConversation(id, limit, offset)

    suspend fun deleteConversation(id: Int) = api.deleteConversation(id)

    suspend fun deleteMessage(id: Int) = api.deleteMessage(id)

    suspend fun getMessageRaw(id: Int): MessageRawData = api.getMessageRaw(id)

    suspend fun getLatestConversationForAgent(agentId: Int): Conversation? {
        val conversations = api.getConversations(agentId)
        return conversations.firstOrNull()
    }
}
