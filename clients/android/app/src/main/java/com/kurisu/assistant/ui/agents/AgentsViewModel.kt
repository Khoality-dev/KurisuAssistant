package com.kurisu.assistant.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.repository.AgentRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AgentsUiState(
    val agents: List<Agent> = emptyList(),
    val selectedAgentId: Int? = null,
    val isLoading: Boolean = false,
    val baseUrl: String = "",
)

@HiltViewModel
class AgentsViewModel @Inject constructor(
    private val agentRepository: AgentRepository,
    private val prefs: PreferencesDataStore,
) : ViewModel() {

    private val _state = MutableStateFlow(AgentsUiState())
    val state: StateFlow<AgentsUiState> = _state

    init {
        loadAgents()
    }

    fun loadAgents() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val agents = agentRepository.loadAgents()
                val savedId = agentRepository.getSelectedAgentId()
                val currentId = _state.value.selectedAgentId ?: savedId
                val stillValid = currentId != null && agents.any { it.id == currentId }
                val finalId = if (stillValid) currentId else agents.firstOrNull()?.id

                if (finalId != null && finalId != currentId) {
                    agentRepository.setSelectedAgentId(finalId)
                }

                _state.update { it.copy(
                    agents = agents,
                    selectedAgentId = finalId,
                    baseUrl = baseUrl,
                ) }
            } catch (_: Exception) {
                // Keep existing state on error
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun selectAgent(agentId: Int) {
        viewModelScope.launch {
            _state.update { it.copy(selectedAgentId = agentId) }
            agentRepository.setSelectedAgentId(agentId)
        }
    }
}
