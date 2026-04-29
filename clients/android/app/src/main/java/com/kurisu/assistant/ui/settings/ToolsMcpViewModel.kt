package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.MCPServerCreate
import com.kurisu.assistant.data.model.MCPServerTestResult
import com.kurisu.assistant.data.model.MCPServerUpdate
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.repository.ToolsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Per-server transient UI state — currently just the latest test result. */
data class McpServerUiMeta(
    val testing: Boolean = false,
    val testResult: MCPServerTestResult? = null,
)

/** Form payload for the add/edit MCP server dialog. */
data class McpServerForm(
    val editingId: Int? = null,
    val name: String = "",
    val transportType: String = "sse",
    val url: String = "",
    val command: String = "",
    val argsText: String = "",
    val envText: String = "",
    val location: String = "server",
    val saving: Boolean = false,
)

data class ToolsMcpUiState(
    val selectedTab: Int = 0,
    val mcpServers: List<MCPServer> = emptyList(),
    val mcpTools: List<Tool> = emptyList(),
    val builtinTools: List<Tool> = emptyList(),
    val isLoading: Boolean = false,
    val message: String? = null,
    val detailTool: Tool? = null,
    val serverForm: McpServerForm? = null,
    val pendingDeleteServerId: Int? = null,
    val serverMeta: Map<Int, McpServerUiMeta> = emptyMap(),
)

@HiltViewModel
class ToolsMcpViewModel @Inject constructor(
    private val repository: ToolsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ToolsMcpUiState())
    val state: StateFlow<ToolsMcpUiState> = _state

    init { loadAll() }

    fun setSelectedTab(index: Int) = _state.update { it.copy(selectedTab = index) }
    fun clearMessage() = _state.update { it.copy(message = null) }

    fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val tools = repository.listTools()
                val servers = repository.listMCPServers()
                _state.update { it.copy(
                    mcpTools = tools.mcpTools,
                    builtinTools = tools.builtinTools,
                    mcpServers = servers,
                ) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed to load: ${e.message}") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun showToolDetail(tool: Tool) = _state.update { it.copy(detailTool = tool) }
    fun dismissToolDetail() = _state.update { it.copy(detailTool = null) }

    // ── MCP server CRUD ──────────────────────────────────────────────

    fun openCreateServer() {
        _state.update { it.copy(serverForm = McpServerForm()) }
    }

    fun openEditServer(server: MCPServer) {
        _state.update { it.copy(serverForm = McpServerForm(
            editingId = server.id,
            name = server.name,
            transportType = server.transportType,
            url = server.url ?: "",
            command = server.command ?: "",
            argsText = server.args.orEmpty().joinToString("\n"),
            envText = server.env.orEmpty().entries.joinToString("\n") { "${it.key}=${it.value}" },
            location = server.location,
        )) }
    }

    fun dismissServerForm() = _state.update { it.copy(serverForm = null) }

    fun updateServerForm(transform: (McpServerForm) -> McpServerForm) {
        _state.update { s -> s.copy(serverForm = s.serverForm?.let(transform)) }
    }

    fun saveServerForm() {
        val form = _state.value.serverForm ?: return
        if (form.name.isBlank()) return

        val args = form.argsText.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        val env = form.envText.split('\n')
            .mapNotNull { line ->
                val trimmed = line.trim()
                if (trimmed.isEmpty()) null
                else {
                    val idx = trimmed.indexOf('=')
                    if (idx <= 0) null
                    else trimmed.substring(0, idx) to trimmed.substring(idx + 1)
                }
            }
            .toMap()

        _state.update { it.copy(serverForm = form.copy(saving = true)) }
        viewModelScope.launch {
            try {
                if (form.editingId == null) {
                    repository.createMCPServer(MCPServerCreate(
                        name = form.name.trim(),
                        transportType = form.transportType,
                        url = form.url.takeIf { it.isNotBlank() },
                        command = form.command.takeIf { it.isNotBlank() },
                        args = args.takeIf { it.isNotEmpty() },
                        env = env.takeIf { it.isNotEmpty() },
                        location = form.location,
                    ))
                } else {
                    repository.updateMCPServer(form.editingId, MCPServerUpdate(
                        name = form.name.trim(),
                        transportType = form.transportType,
                        url = form.url.takeIf { it.isNotBlank() },
                        command = form.command.takeIf { it.isNotBlank() },
                        args = args.takeIf { it.isNotEmpty() },
                        env = env.takeIf { it.isNotEmpty() },
                        location = form.location,
                    ))
                }
                _state.update { it.copy(serverForm = null, message = "Server saved") }
                loadAll()
            } catch (e: Exception) {
                _state.update { it.copy(
                    serverForm = form.copy(saving = false),
                    message = "Save failed: ${e.message}",
                ) }
            }
        }
    }

    fun toggleServerEnabled(server: MCPServer) {
        viewModelScope.launch {
            try {
                repository.updateMCPServer(server.id, MCPServerUpdate(enabled = !server.enabled))
                loadAll()
            } catch (e: Exception) {
                _state.update { it.copy(message = "Toggle failed: ${e.message}") }
            }
        }
    }

    fun confirmDeleteServer(id: Int) = _state.update { it.copy(pendingDeleteServerId = id) }
    fun cancelDeleteServer() = _state.update { it.copy(pendingDeleteServerId = null) }

    fun deleteServer() {
        val id = _state.value.pendingDeleteServerId ?: return
        _state.update { it.copy(pendingDeleteServerId = null) }
        viewModelScope.launch {
            try {
                repository.deleteMCPServer(id)
                _state.update { it.copy(
                    mcpServers = it.mcpServers.filterNot { s -> s.id == id },
                    serverMeta = it.serverMeta - id,
                    message = "Server deleted",
                ) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Delete failed: ${e.message}") }
            }
        }
    }

    fun testServer(id: Int) {
        _state.update { it.copy(serverMeta = it.serverMeta + (id to McpServerUiMeta(testing = true))) }
        viewModelScope.launch {
            val result = try {
                repository.testMCPServer(id)
            } catch (e: Exception) {
                MCPServerTestResult(status = "unavailable", error = e.message)
            }
            _state.update { it.copy(
                serverMeta = it.serverMeta + (id to McpServerUiMeta(testing = false, testResult = result)),
            ) }
        }
    }
}
