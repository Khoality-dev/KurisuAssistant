package com.kurisu.assistant.ui.chat

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.model.FrameInfo
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.service.VoiceInteractionManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ChatUiState(
    val agents: List<Agent> = emptyList(),
    val selectedAgent: Agent? = null,
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val isLoadingMore: Boolean = false,
    val conversationId: Int? = null,
    val baseUrl: String = "",
    val inputText: String = "",
    val selectedImages: List<Uri> = emptyList(),
    val userAvatarUuid: String? = null,
    val frames: Map<String, FrameInfo> = emptyMap(),
)

@HiltViewModel
class ChatViewModel @Inject constructor(
    private val application: Application,
    private val savedStateHandle: SavedStateHandle,
    private val agentRepository: AgentRepository,
    private val authRepository: AuthRepository,
    private val conversationRepository: ConversationRepository,
    private val prefs: PreferencesDataStore,
    private val wsManager: WebSocketManager,
    val streamProcessor: ChatStreamProcessor,
    val ttsQueueManager: TtsQueueManager,
    val voiceInteractionManager: VoiceInteractionManager,
    private val coreState: CoreState,
) : ViewModel() {

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state

    val streamingState = streamProcessor.state
    val ttsState = ttsQueueManager.state
    val voiceState = voiceInteractionManager.state
    val coreServiceState = coreState.state

    // Nav args
    private val navAgentId: Int = savedStateHandle["agentId"] ?: -1
    private val navTriggerText: String? = savedStateHandle["triggerText"]

    init {
        // Safety net: ensure event collection is active even if service hasn't started yet
        streamProcessor.startCollecting()

        // Initial load
        viewModelScope.launch {
            val baseUrl = prefs.getBackendUrl()
            _state.update { it.copy(baseUrl = baseUrl) }

            // Load user avatar
            try {
                val profile = authRepository.loadUserProfile()
                _state.update { it.copy(userAvatarUuid = profile.userAvatarUuid) }
            } catch (_: Exception) {}

            loadAgentAndConversation()

            // After loading, handle trigger text (auto-start voice interaction)
            if (navTriggerText != null) {
                sendMessage(navTriggerText)
            }
        }

        // Observe service state for conversation ID sync (when service creates a new conversation via voice)
        viewModelScope.launch {
            coreState.state.collect { svcState ->
                val currentConvId = _state.value.conversationId
                val serviceConvId = svcState.conversationId
                if (serviceConvId != null && serviceConvId != currentConvId) {
                    _state.update { it.copy(conversationId = serviceConvId) }
                    loadConversation(serviceConvId)
                }
            }
        }

        // Observe stream-done: reload from DB then clear ephemeral streaming messages
        viewModelScope.launch {
            coreState.streamDone.collect {
                val convId = _state.value.conversationId
                if (convId != null) {
                    try {
                        loadConversation(convId)
                    } catch (e: Exception) {
                        Log.e("ChatViewModel", "Failed to reload on stream done", e)
                    }
                }
                streamProcessor.clearStreamingMessages()
            }
        }
    }

    /** Load the specific agent from nav args + its conversation. Also load all agents for dropdown. */
    private suspend fun loadAgentAndConversation() {
        try {
            val agents = agentRepository.loadAgents()
            val selectedAgent = agents.find { it.id == navAgentId } ?: agents.firstOrNull()

            _state.update { it.copy(agents = agents, selectedAgent = selectedAgent) }

            if (selectedAgent != null) {
                agentRepository.setSelectedAgentId(selectedAgent.id)
                voiceInteractionManager.setTriggerWord(selectedAgent.triggerWord)
                coreState.setSelectedAgentId(selectedAgent.id)

                val convId = agentRepository.getConversationIdForAgent(selectedAgent.id)
                if (convId != null) {
                    loadConversation(convId)
                } else {
                    _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                }
            }
        } catch (e: Exception) {
            Log.e("ChatViewModel", "Failed to load agents/conversation", e)
        }
    }

    fun selectAgent(agentId: Int) {
        viewModelScope.launch {
            val agent = _state.value.agents.find { it.id == agentId } ?: return@launch
            _state.update { it.copy(selectedAgent = agent) }
            agentRepository.setSelectedAgentId(agentId)
            voiceInteractionManager.setTriggerWord(agent.triggerWord)
            coreState.setSelectedAgentId(agentId)

            ttsQueueManager.clearQueue()

            val convId = agentRepository.getConversationIdForAgent(agentId)
            if (convId != null) {
                try {
                    loadConversation(convId)
                } catch (_: Exception) {
                    agentRepository.clearConversationIdForAgent(agentId)
                    _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                }
            } else {
                _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
            }
        }
    }

    private suspend fun loadConversation(id: Int) {
        val detail = conversationRepository.getConversation(id, 20, 0)
        _state.update { it.copy(
            messages = detail.messages,
            conversationId = id,
            hasMore = detail.hasMore,
            isLoadingMore = false,
            frames = detail.frames,
        ) }
        coreState.setConversationId(id)
    }

    fun loadMoreMessages() {
        val s = _state.value
        if (s.isLoadingMore || !s.hasMore || s.conversationId == null) return

        viewModelScope.launch {
            _state.update { it.copy(isLoadingMore = true) }
            try {
                val detail = conversationRepository.getConversation(
                    s.conversationId, 20, s.messages.size,
                )
                _state.update { it.copy(
                    messages = detail.messages + it.messages,
                    hasMore = detail.hasMore,
                    isLoadingMore = false,
                    frames = it.frames + detail.frames,
                ) }
            } catch (_: Exception) {
                _state.update { it.copy(isLoadingMore = false) }
            }
        }
    }

    fun setInputText(text: String) = _state.update { it.copy(inputText = text) }

    fun addImage(uri: Uri) = _state.update { it.copy(selectedImages = it.selectedImages + uri) }

    fun removeImage(index: Int) = _state.update {
        it.copy(selectedImages = it.selectedImages.toMutableList().also { list -> list.removeAt(index) })
    }

    fun sendMessage(text: String? = null) {
        if (streamProcessor.state.value.isStreaming) return
        val s = _state.value
        val messageText = text ?: s.inputText.trim()
        if (messageText.isBlank() && s.selectedImages.isEmpty()) return

        // TODO: Upload images and get UUIDs. For now, send text only.
        val images = emptyList<String>()

        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(messageText, images)
        _state.update { it.copy(inputText = "", selectedImages = emptyList()) }

        viewModelScope.launch {
            try {
                val modelName = prefs.getSelectedModel() ?: ""
                wsManager.sendChatRequest(
                    text = messageText,
                    modelName = modelName,
                    conversationId = s.conversationId,
                    agentId = s.selectedAgent?.id,
                    images = images,
                )
            } catch (e: Exception) {
                streamProcessor.setError(e.message ?: "Failed to send message")
            }
        }
    }

    fun resendMessage(messageId: Int, text: String) {
        val s = _state.value
        if (s.conversationId == null) return

        viewModelScope.launch {
            try {
                // Delete from this message onward
                conversationRepository.deleteMessage(messageId)
                loadConversation(s.conversationId)

                // Re-send the same text
                sendMessage(text)
            } catch (e: Exception) {
                Log.e("ChatViewModel", "Failed to resend message", e)
            }
        }
    }

    fun cancelStream() {
        streamProcessor.cancelStream()
        ttsQueueManager.clearQueue()
    }

    fun deleteConversation() {
        val convId = _state.value.conversationId ?: return
        viewModelScope.launch {
            try {
                conversationRepository.deleteConversation(convId)
                val agentId = _state.value.selectedAgent?.id
                if (agentId != null) agentRepository.clearConversationIdForAgent(agentId)
                _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                coreState.setConversationId(null)
            } catch (_: Exception) {}
        }
    }

    fun deleteMessage(messageId: Int) {
        val convId = _state.value.conversationId ?: return
        viewModelScope.launch {
            try {
                conversationRepository.deleteMessage(messageId)
                loadConversation(convId)
            } catch (e: Exception) {
                Log.e("ChatViewModel", "Failed to delete message", e)
            }
        }
    }

    suspend fun getMessageRaw(messageId: Int): MessageRawData? {
        return try {
            conversationRepository.getMessageRaw(messageId)
        } catch (e: Exception) {
            Log.e("ChatViewModel", "Failed to fetch raw data", e)
            null
        }
    }

    fun refreshAgents() {
        viewModelScope.launch { loadAgentAndConversation() }
    }
}
