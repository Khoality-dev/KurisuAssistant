package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AgentRepository @Inject constructor(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
    private val conversationRepository: ConversationRepository,
) {
    companion object {
        private const val ADMINISTRATOR_NAME = "Administrator"
    }

    suspend fun loadAgents(): List<Agent> {
        val all = api.listAgents()
        return all.filter { it.name != ADMINISTRATOR_NAME }
    }

    suspend fun getSelectedAgentId(): Int? = prefs.getSelectedAgentId()

    suspend fun setSelectedAgentId(id: Int) = prefs.setSelectedAgentId(id)

    suspend fun clearSelectedAgentId() = prefs.clearSelectedAgentId()

    /** Get conversation ID for an agent, with fallback to backend query */
    suspend fun getConversationIdForAgent(agentId: Int): Int? {
        // First check local mapping
        val localId = prefs.getAgentConversationId(agentId)
        if (localId != null) return localId

        // Fallback: query backend
        val conv = conversationRepository.getLatestConversationForAgent(agentId)
        if (conv != null) {
            prefs.setAgentConversationId(agentId, conv.id)
            return conv.id
        }

        return null
    }

    suspend fun setConversationIdForAgent(agentId: Int, conversationId: Int) {
        prefs.setAgentConversationId(agentId, conversationId)
    }

    suspend fun clearConversationIdForAgent(agentId: Int) {
        prefs.clearAgentConversationId(agentId)
    }

    fun getImageUrl(baseUrl: String, uuid: String): String =
        "${baseUrl.trimEnd('/')}/images/$uuid"
}
