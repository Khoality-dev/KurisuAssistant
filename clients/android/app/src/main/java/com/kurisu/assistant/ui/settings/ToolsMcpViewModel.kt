package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.repository.ToolsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ToolsMcpUiState(
    val selectedTab: Int = 0,
    val mcpServers: List<MCPServer> = emptyList(),
    val mcpTools: List<Tool> = emptyList(),
    val builtinTools: List<Tool> = emptyList(),
    val isLoading: Boolean = false,
    val message: String? = null,
    val detailTool: Tool? = null,
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
}
