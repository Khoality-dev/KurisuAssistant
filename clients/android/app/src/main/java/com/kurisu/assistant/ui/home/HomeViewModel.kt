package com.kurisu.assistant.ui.home

import android.app.Application
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.domain.voice.VoiceInteractionManager
import com.kurisu.assistant.service.ChatForegroundService
import com.kurisu.assistant.service.ServiceState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AgentConversation(
    val agent: Agent,
    val lastMessage: String? = null,
    val lastMessageTime: String? = null,
    val conversationId: Int? = null,
)

data class HomeUiState(
    val conversations: List<AgentConversation> = emptyList(),
    val isLoading: Boolean = false,
    val baseUrl: String = "",
)

data class TriggerMatch(
    val agentId: Int,
    val text: String,
)

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val application: Application,
    private val agentRepository: AgentRepository,
    private val conversationRepository: ConversationRepository,
    private val prefs: PreferencesDataStore,
    val voiceInteractionManager: VoiceInteractionManager,
    private val serviceState: ServiceState,
) : ViewModel() {

    companion object {
        private const val TAG = "HomeViewModel"
    }

    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state

    val serviceRunning = serviceState.state.map { it.isServiceRunning }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _triggerMatch = MutableSharedFlow<TriggerMatch>(extraBufferCapacity = 1)
    val triggerMatch: SharedFlow<TriggerMatch> = _triggerMatch

    init {
        loadConversations()

        // Wire raw transcript for trigger word matching across all agents
        voiceInteractionManager.onRawTranscript = { text ->
            val match = _state.value.conversations.find { conv ->
                conv.agent.triggerWord != null &&
                    text.lowercase().contains(conv.agent.triggerWord!!.lowercase())
            }
            if (match != null) {
                _triggerMatch.tryEmit(TriggerMatch(match.agent.id, text))
            }
        }

    }

    fun toggleService() {
        if (serviceState.state.value.isServiceRunning) {
            ChatForegroundService.stop(application)
        } else {
            ChatForegroundService.start(application)
        }
    }

    fun startService() {
        ChatForegroundService.start(application)
    }

    fun loadConversations() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val baseUrl = prefs.getBackendUrl()
                val agents = agentRepository.loadAgents()

                val conversations = coroutineScope {
                    agents.map { agent ->
                        async {
                            try {
                                val convId = agentRepository.getConversationIdForAgent(agent.id)
                                if (convId != null) {
                                    val detail = conversationRepository.getConversation(convId, limit = 1, offset = 0)
                                    val lastMsg = detail.messages.lastOrNull()
                                    AgentConversation(
                                        agent = agent,
                                        lastMessage = lastMsg?.content,
                                        lastMessageTime = lastMsg?.createdAt,
                                        conversationId = convId,
                                    )
                                } else {
                                    AgentConversation(agent = agent)
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to fetch conversation for agent ${agent.id}", e)
                                AgentConversation(agent = agent)
                            }
                        }
                    }.awaitAll()
                }

                // Sort: agents with recent messages first (by timestamp desc), then agents without
                val sorted = conversations.sortedWith(
                    compareByDescending<AgentConversation> { it.lastMessageTime != null }
                        .thenByDescending { it.lastMessageTime ?: "" }
                )

                _state.update { it.copy(conversations = sorted, baseUrl = baseUrl) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load conversations", e)
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        voiceInteractionManager.onRawTranscript = null
    }
}
