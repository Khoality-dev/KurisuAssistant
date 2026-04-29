package com.kurisu.assistant.ui.chat

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.model.ContextInfoEvent
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
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

/** Modal overlay surfaced from a slash command. Only one can be active at a time. */
sealed class ChatModal {
    data class ResumePicker(val conversations: List<Conversation>, val loading: Boolean = false) : ChatModal()
    data class AgentPicker(val agents: List<Agent>, val loading: Boolean = false) : ChatModal()
    data class ContextDialog(
        val conversationId: Int?,
        val tokenCount: Int?,
        val compacting: Boolean,
        val compactedUpToId: Int,
        val compactedContext: String,
    ) : ChatModal()
}

data class ChatUiState(
    val agent: Agent? = null,
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val isLoadingMore: Boolean = false,
    val conversationId: Int? = null,
    val baseUrl: String = "",
    val inputText: String = "",
    val selectedImages: List<Uri> = emptyList(),
    val userAvatarUuid: String? = null,
    val pendingApproval: ToolApprovalRequestEvent? = null,
    val commandFeedback: String? = null,
    val modal: ChatModal? = null,
    val lastContextInfo: ContextInfoEvent? = null,
    val alwaysListen: Boolean = true,
)

@HiltViewModel
class ChatViewModel @Inject constructor(
    private val application: Application,
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

    companion object {
        private const val TAG = "ChatViewModel"
    }

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state

    val streamingState = streamProcessor.state
    val ttsState = ttsQueueManager.state
    val voiceState = voiceInteractionManager.state
    val coreServiceState = coreState.state

    init {
        // Ensure event collection is active
        streamProcessor.startCollecting()

        // Mirror ContextInfoEvent into UI state so /context can render it
        streamProcessor.onContextInfo = { event ->
            _state.update { it.copy(
                lastContextInfo = event,
                modal = (it.modal as? ChatModal.ContextDialog)?.copy(
                    compacting = event.compacting,
                    compactedUpToId = event.compactedUpToId,
                    compactedContext = event.compactedContext,
                ) ?: it.modal,
            ) }
        }

        // Load the default agent and its conversation
        viewModelScope.launch {
            val baseUrl = prefs.getBackendUrl()
            val alwaysListen = prefs.getAsrAlwaysListen()
            _state.update { it.copy(baseUrl = baseUrl, alwaysListen = alwaysListen) }

            try {
                val profile = authRepository.loadUserProfile()
                _state.update { it.copy(userAvatarUuid = profile.userAvatarUuid) }
            } catch (_: Exception) {}

            loadAgent()
        }

        // Observe service state for conversation ID sync
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

        // Observe tool approval requests
        viewModelScope.launch {
            wsManager.events.collect { event ->
                if (event is ToolApprovalRequestEvent) {
                    _state.update { it.copy(pendingApproval = event) }
                }
            }
        }

        // Observe dictation drafts from ASR (transcripts not matched as trigger word)
        viewModelScope.launch {
            coreState.dictationDrafts.collect { text ->
                _state.update { it.copy(inputText = text) }
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
                        Log.e(TAG, "Failed to reload on stream done", e)
                    }
                }
                streamProcessor.clearStreamingMessages()
                processQueue()
            }
        }
    }

    /** Load the first available agent and its conversation. */
    private suspend fun loadAgent() {
        try {
            val agents = agentRepository.loadAgents()
            // Use previously selected agent, or fall back to first
            val selectedId = agentRepository.getSelectedAgentId()
            val agent = (if (selectedId != null) agents.find { it.id == selectedId } else null)
                ?: agents.firstOrNull()

            _state.update { it.copy(agent = agent) }

            if (agent != null) {
                agentRepository.setSelectedAgentId(agent.id)
                voiceInteractionManager.setTriggerWord(
                    agent.persona?.triggerWord ?: agent.triggerWord,
                )
                coreState.setSelectedAgentId(agent.id)

                val convId = agentRepository.getConversationIdForAgent(agent.id)
                if (convId != null) {
                    loadConversation(convId)
                } else {
                    _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load agent/conversation", e)
        }
    }

    private suspend fun loadConversation(id: Int) {
        val detail = conversationRepository.getConversation(id, 20, 0)
        _state.update { it.copy(
            messages = detail.messages,
            conversationId = id,
            hasMore = detail.hasMore,
            isLoadingMore = false,
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
        val s = _state.value
        val messageText = text ?: s.inputText.trim()
        if (messageText.isBlank() && s.selectedImages.isEmpty()) return

        // Slash commands are intercepted client-side and never reach the backend.
        SlashCommands.parse(messageText)?.let { (cmd, args) ->
            _state.update { it.copy(inputText = "") }
            executeCommand(cmd, args)
            return
        }

        val images = emptyList<String>()
        _state.update { it.copy(inputText = "", selectedImages = emptyList()) }

        // If currently streaming, queue the message
        if (streamProcessor.state.value.isStreaming) {
            streamProcessor.queueMessage(messageText, images)
            return
        }

        doSend(messageText, images)
    }

    private fun executeCommand(cmd: SlashCommand, args: String) {
        when (cmd.name) {
            "clear" -> clearCurrentConversation()
            "delete" -> deleteConversation()
            "refresh" -> refreshConversation()
            "resume" -> openResumePicker()
            "agents" -> openAgentPicker()
            "context" -> openContextDialog()
            "compact" -> compactContext()
        }
    }

    /**
     * Non-destructive: drop the conversation from view so the next send creates a new one
     * on the backend. Existing messages stay on the server and can be re-loaded via /resume.
     */
    fun clearCurrentConversation() {
        val agentId = _state.value.agent?.id
        viewModelScope.launch {
            if (agentId != null) agentRepository.clearConversationIdForAgent(agentId)
            _state.update { it.copy(
                messages = emptyList(),
                conversationId = null,
                hasMore = false,
                commandFeedback = "Started a new conversation",
            ) }
            coreState.setConversationId(null)
        }
    }

    private fun openResumePicker() {
        val agentId = _state.value.agent?.id
        _state.update { it.copy(modal = ChatModal.ResumePicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                val convs = conversationRepository.getConversations(agentId)
                _state.update { it.copy(modal = ChatModal.ResumePicker(convs, loading = false)) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load conversations", e)
                _state.update { it.copy(
                    modal = null,
                    commandFeedback = "Failed to load conversations",
                ) }
            }
        }
    }

    private fun openAgentPicker() {
        _state.update { it.copy(modal = ChatModal.AgentPicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                val agents = agentRepository.loadAgents()
                _state.update { it.copy(modal = ChatModal.AgentPicker(agents, loading = false)) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load agents", e)
                _state.update { it.copy(
                    modal = null,
                    commandFeedback = "Failed to load agents",
                ) }
            }
        }
    }

    private fun openContextDialog() {
        val s = _state.value
        val info = s.lastContextInfo
        _state.update { it.copy(modal = ChatModal.ContextDialog(
            conversationId = s.conversationId,
            tokenCount = streamProcessor.state.value.tokenCount,
            compacting = info?.compacting ?: false,
            compactedUpToId = info?.compactedUpToId ?: 0,
            compactedContext = info?.compactedContext ?: "",
        )) }
    }

    private fun compactContext() {
        val convId = _state.value.conversationId
        if (convId == null) {
            _state.update { it.copy(commandFeedback = "No conversation to compact") }
            return
        }
        viewModelScope.launch {
            try {
                wsManager.sendCompactContext(convId)
                _state.update { it.copy(commandFeedback = "Compacting conversation...") }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send compact request", e)
                _state.update { it.copy(commandFeedback = "Failed to compact") }
            }
        }
    }

    fun dismissModal() = _state.update { it.copy(modal = null) }

    fun clearCommandFeedback() = _state.update { it.copy(commandFeedback = null) }

    /**
     * Toggle the "Always Listen" preference and immediately apply by flipping the recording
     * state. Returns the new value so the caller can decide whether to invoke
     * [com.kurisu.assistant.service.CoreService.toggleRecording] (which needs a Context).
     */
    fun toggleAlwaysListen(): Boolean {
        val newValue = !_state.value.alwaysListen
        _state.update { it.copy(
            alwaysListen = newValue,
            commandFeedback = if (newValue) "Always Listen on" else "Always Listen off",
        ) }
        viewModelScope.launch {
            try { prefs.setAsrAlwaysListen(newValue) } catch (e: Exception) {
                Log.e(TAG, "Failed to persist always-listen", e)
            }
        }
        return newValue
    }

    fun resumeConversation(conversationId: Int) {
        viewModelScope.launch {
            try {
                loadConversation(conversationId)
                val agentId = _state.value.agent?.id
                if (agentId != null) {
                    agentRepository.setConversationIdForAgent(agentId, conversationId)
                }
                _state.update { it.copy(modal = null) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to resume conversation", e)
                _state.update { it.copy(
                    modal = null,
                    commandFeedback = "Failed to resume conversation",
                ) }
            }
        }
    }

    fun switchAgent(agent: Agent) {
        viewModelScope.launch {
            try {
                agentRepository.setSelectedAgentId(agent.id)
                voiceInteractionManager.setTriggerWord(
                    agent.persona?.triggerWord ?: agent.triggerWord,
                )
                coreState.setSelectedAgentId(agent.id)
                _state.update { it.copy(agent = agent, modal = null) }

                val convId = agentRepository.getConversationIdForAgent(agent.id)
                if (convId != null) {
                    loadConversation(convId)
                } else {
                    _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                    coreState.setConversationId(null)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to switch agent", e)
                _state.update { it.copy(
                    modal = null,
                    commandFeedback = "Failed to switch agent",
                ) }
            }
        }
    }

    private fun doSend(text: String, images: List<String>) {
        val s = _state.value
        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(text, images)

        viewModelScope.launch {
            try {
                val modelName = prefs.getSelectedModel() ?: ""
                wsManager.sendChatRequest(
                    text = text,
                    modelName = modelName,
                    conversationId = s.conversationId,
                    agentId = s.agent?.id,
                    images = images,
                )
            } catch (e: Exception) {
                streamProcessor.setError(e.message ?: "Failed to send message")
            }
        }
    }

    /** Called after stream done + DB reload — process queued messages. */
    private fun processQueue() {
        val queued = streamProcessor.dequeueMessage() ?: return
        doSend(queued.text, queued.images)
    }

    fun resendMessage(messageId: Int, text: String) {
        val s = _state.value
        if (s.conversationId == null) return

        viewModelScope.launch {
            try {
                conversationRepository.deleteMessage(messageId)
                loadConversation(s.conversationId)
                sendMessage(text)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to resend message", e)
            }
        }
    }

    fun approveToolCall() {
        val approval = _state.value.pendingApproval ?: return
        wsManager.sendToolApprovalResponse(approval.approvalId, approved = true)
        _state.update { it.copy(pendingApproval = null) }
    }

    fun denyToolCall() {
        val approval = _state.value.pendingApproval ?: return
        wsManager.sendToolApprovalResponse(approval.approvalId, approved = false)
        _state.update { it.copy(pendingApproval = null) }
    }

    fun cancelStream() {
        streamProcessor.cancelStream()
        ttsQueueManager.clearQueue()
    }

    fun refreshConversation() {
        val convId = _state.value.conversationId ?: return
        viewModelScope.launch {
            try {
                loadConversation(convId)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to refresh conversation", e)
            }
        }
    }

    fun deleteConversation() {
        val convId = _state.value.conversationId ?: return
        viewModelScope.launch {
            try {
                conversationRepository.deleteConversation(convId)
                val agentId = _state.value.agent?.id
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
                Log.e(TAG, "Failed to delete message", e)
            }
        }
    }

    suspend fun getMessageRaw(messageId: Int): MessageRawData? {
        return try {
            conversationRepository.getMessageRaw(messageId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to fetch raw data", e)
            null
        }
    }

    fun logout(onLogout: () -> Unit) {
        viewModelScope.launch {
            try {
                authRepository.logout()
            } catch (_: Exception) {}
            onLogout()
        }
    }

    override fun onCleared() {
        super.onCleared()
        if (voiceInteractionManager.state.value.isInteractionMode) {
            voiceInteractionManager.exitMode()
        }
        voiceInteractionManager.setTriggerWord(null)
        coreState.setSelectedAgentId(null)
    }
}
