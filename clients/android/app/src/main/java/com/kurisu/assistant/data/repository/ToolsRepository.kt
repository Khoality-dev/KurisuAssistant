package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.Skill
import com.kurisu.assistant.data.model.SkillCreate
import com.kurisu.assistant.data.model.SkillUpdate
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.model.ToolsResponse
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ToolsRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun listTools(): ToolsResponse = api.listTools()

    suspend fun listMCPServers(): List<MCPServer> = api.listMCPServers().servers

    suspend fun listSkills(): List<Skill> = api.listSkills()

    suspend fun createSkill(name: String, instructions: String): Skill =
        api.createSkill(SkillCreate(name = name, instructions = instructions))

    suspend fun updateSkill(id: Int, name: String? = null, instructions: String? = null): Skill =
        api.updateSkill(id, SkillUpdate(name = name, instructions = instructions))

    suspend fun deleteSkill(id: Int) = api.deleteSkill(id)
}
