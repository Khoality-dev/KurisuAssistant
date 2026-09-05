package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.EnabledUpdate
import com.kurisu.assistant.data.model.SubAgent
import com.kurisu.assistant.data.model.SubAgentCreate
import com.kurisu.assistant.data.model.SubAgentUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Sub-agents: task-only workers the assistant delegates to mid-answer.
 *
 * They carry their own model and tools but no identity — no avatar, no voice,
 * no memory — and are never bound to a conversation, so there is deliberately no
 * conversation mapping here the way [PersonaRepository] has one.
 */
@Singleton
class SubAgentRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun listSubAgents(): List<SubAgent> = api.listSubAgents()

    suspend fun getSubAgent(id: Int): SubAgent = api.getSubAgent(id)

    suspend fun createSubAgent(data: SubAgentCreate): SubAgent = api.createSubAgent(data)

    suspend fun updateSubAgent(id: Int, data: SubAgentUpdate): SubAgent =
        api.updateSubAgent(id, data)

    suspend fun deleteSubAgent(id: Int) = api.deleteSubAgent(id)

    suspend fun setSubAgentEnabled(id: Int, enabled: Boolean): SubAgent =
        api.setSubAgentEnabled(id, EnabledUpdate(enabled))
}
