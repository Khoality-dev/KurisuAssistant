package com.kurisu.assistant.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.model.AgentCreate
import com.kurisu.assistant.data.model.AgentUpdate
import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.ToolsRepository
import com.kurisu.assistant.data.repository.TtsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AgentsUiState(
    val agents: List<Agent> = emptyList(),
    val isLoading: Boolean = false,
    val baseUrl: String = "",
    val message: String? = null,
    // Available options for editor
    val availableModels: List<String> = emptyList(),
    val availableTools: List<Tool> = emptyList(),
    val availableVoices: List<String> = emptyList(),
    // Editor dialog
    val showEditor: Boolean = false,
    val editingAgent: Agent? = null,
    val editorName: String = "",
    val editorModelName: String = "",
    val editorSystemPrompt: String = "",
    val editorTriggerWord: String = "",
    val editorThink: Boolean = false,
    val editorVoiceReference: String = "",
    val editorTools: List<String> = emptyList(),
    val editorMemory: String = "",
    val isSaving: Boolean = false,
    // Delete confirmation
    val deletingAgent: Agent? = null,
)

@HiltViewModel
class AgentsViewModel @Inject constructor(
    private val agentRepository: AgentRepository,
    private val toolsRepository: ToolsRepository,
    private val ttsRepository: TtsRepository,
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(AgentsUiState())
    val state: StateFlow<AgentsUiState> = _state

    init {
        loadAll()
    }

    fun loadAll() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val agents = agentRepository.loadAgents()
                _state.update { it.copy(agents = agents, baseUrl = baseUrl) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed to load: ${e.message}") }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }

            // Load models and tools in background for editor
            try {
                val models = agentRepository.listModels()
                _state.update { it.copy(availableModels = models) }
            } catch (_: Exception) {}
            try {
                val tools = toolsRepository.listTools()
                val allTools = tools.mcpTools + tools.builtinTools
                _state.update { it.copy(availableTools = allTools) }
            } catch (_: Exception) {}
            try {
                val voices = ttsRepository.listVoices(null)
                _state.update { it.copy(availableVoices = voices) }
            } catch (_: Exception) {}
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    // Editor
    fun openNewEditor() = _state.update { it.copy(
        showEditor = true,
        editingAgent = null,
        editorName = "",
        editorModelName = it.availableModels.firstOrNull() ?: "",
        editorSystemPrompt = "",
        editorVoiceReference = "",
        editorTriggerWord = "",
        editorThink = false,
        editorTools = emptyList(),
        editorMemory = "",
    ) }

    fun openEditEditor(agent: Agent) = _state.update { it.copy(
        showEditor = true,
        editingAgent = agent,
        editorName = agent.name,
        editorModelName = agent.modelName ?: "",
        editorSystemPrompt = agent.systemPrompt,
        editorVoiceReference = agent.voiceReference ?: "",
        editorTriggerWord = agent.triggerWord ?: "",
        editorThink = agent.think,
        editorTools = agent.tools ?: emptyList(),
        editorMemory = agent.memory ?: "",
    ) }

    fun dismissEditor() = _state.update { it.copy(showEditor = false, editingAgent = null) }

    fun setEditorName(v: String) = _state.update { it.copy(editorName = v) }
    fun setEditorModelName(v: String) = _state.update { it.copy(editorModelName = v) }
    fun setEditorSystemPrompt(v: String) = _state.update { it.copy(editorSystemPrompt = v) }
    fun setEditorVoiceReference(v: String) = _state.update { it.copy(editorVoiceReference = v) }
    fun setEditorTriggerWord(v: String) = _state.update { it.copy(editorTriggerWord = v) }
    fun setEditorThink(v: Boolean) = _state.update { it.copy(editorThink = v) }
    fun setEditorMemory(v: String) = _state.update { it.copy(editorMemory = v) }

    fun toggleEditorTool(toolName: String) = _state.update {
        val current = it.editorTools.toMutableList()
        if (toolName in current) current.remove(toolName) else current.add(toolName)
        it.copy(editorTools = current)
    }

    fun saveAgent() {
        val s = _state.value
        if (s.editorName.isBlank()) {
            _state.update { it.copy(message = "Name is required") }
            return
        }
        if (s.editorModelName.isBlank()) {
            _state.update { it.copy(message = "Model is required") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                if (s.editingAgent != null) {
                    agentRepository.updateAgent(s.editingAgent.id, AgentUpdate(
                        name = s.editorName.trim(),
                        modelName = s.editorModelName.trim(),
                        systemPrompt = s.editorSystemPrompt,
                        voiceReference = s.editorVoiceReference.trim().ifBlank { null },
                        triggerWord = s.editorTriggerWord.trim().ifBlank { null },
                        think = s.editorThink,
                        tools = s.editorTools,
                        memory = s.editorMemory.ifBlank { null },
                    ))
                    _state.update { it.copy(message = "Agent updated") }
                } else {
                    agentRepository.createAgent(AgentCreate(
                        name = s.editorName.trim(),
                        modelName = s.editorModelName.trim(),
                        systemPrompt = s.editorSystemPrompt.ifBlank { null },
                        voiceReference = s.editorVoiceReference.trim().ifBlank { null },
                        triggerWord = s.editorTriggerWord.trim().ifBlank { null },
                        think = s.editorThink,
                        tools = s.editorTools.ifEmpty { null },
                    ))
                    _state.update { it.copy(message = "Agent created") }
                }
                _state.update { it.copy(showEditor = false, editingAgent = null) }
                reloadAgents()
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    // Delete
    fun confirmDelete(agent: Agent) = _state.update { it.copy(deletingAgent = agent) }
    fun dismissDelete() = _state.update { it.copy(deletingAgent = null) }

    fun deleteAgent() {
        val agent = _state.value.deletingAgent ?: return
        viewModelScope.launch {
            try {
                agentRepository.deleteAgent(agent.id)
                _state.update { it.copy(deletingAgent = null, message = "Agent deleted") }
                reloadAgents()
            } catch (e: Exception) {
                _state.update { it.copy(deletingAgent = null, message = "Failed: ${e.message}") }
            }
        }
    }

    private fun reloadAgents() {
        viewModelScope.launch {
            try {
                val agents = agentRepository.loadAgents()
                _state.update { it.copy(agents = agents) }
            } catch (_: Exception) {}
        }
    }
}
