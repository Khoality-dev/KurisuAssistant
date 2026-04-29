package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.MCPServerCreate
import com.kurisu.assistant.data.model.MCPServerTestResult
import com.kurisu.assistant.data.model.MCPServerUpdate
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

    suspend fun listMCPServers(): List<MCPServer> = api.listMCPServers()
    suspend fun createMCPServer(data: MCPServerCreate): MCPServer = api.createMCPServer(data)
    suspend fun updateMCPServer(id: Int, data: MCPServerUpdate): MCPServer = api.updateMCPServer(id, data)
    suspend fun deleteMCPServer(id: Int) = api.deleteMCPServer(id)
    suspend fun testMCPServer(id: Int): MCPServerTestResult = api.testMCPServer(id)

    suspend fun listSkills(): List<Skill> = api.listSkills()

    suspend fun createSkill(name: String, instructions: String): Skill =
        api.createSkill(SkillCreate(name = name, instructions = instructions))

    suspend fun updateSkill(id: Int, name: String? = null, instructions: String? = null): Skill =
        api.updateSkill(id, SkillUpdate(name = name, instructions = instructions))

    suspend fun deleteSkill(id: Int) = api.deleteSkill(id)
}
