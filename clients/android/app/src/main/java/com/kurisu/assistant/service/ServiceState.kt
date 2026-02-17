package com.kurisu.assistant.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class ChatServiceState(
    val isServiceRunning: Boolean = false,
    val conversationId: Int? = null,
    val selectedAgentId: Int? = null,
)

@Singleton
class ServiceState @Inject constructor() {
    private val _state = MutableStateFlow(ChatServiceState())
    val state: StateFlow<ChatServiceState> = _state

    fun setServiceRunning(running: Boolean) {
        _state.update { it.copy(isServiceRunning = running) }
    }

    fun setConversationId(id: Int?) {
        _state.update { it.copy(conversationId = id) }
    }

    fun setSelectedAgentId(id: Int?) {
        _state.update { it.copy(selectedAgentId = id) }
    }
}
