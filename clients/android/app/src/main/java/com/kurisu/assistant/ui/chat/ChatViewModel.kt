package com.kurisu.assistant.ui.chat

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.ContextInfoEvent
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.PersonaRepository
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
    data class PersonaPicker(val personas: List<Persona>, val loading: Boolean = false) : ChatModal()
    data class ContextDialog(
        val conversationId: Int?,
        val tokenCount: Int?,
        val compacting: Boolean,
        val compactedUpToId: Int,
        val compactedContext: String,
    ) : ChatModal()
}

data class ChatUiState(
    /** The persona bound to THIS conversation — the one the header names. */
    val persona: Persona? = null,
    /** The one assistant: model, tools, memory, wake word, default persona. */
    val assistant: Assistant? = null,
    val personas: List<Persona> = emptyList(),
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
    val deleteConfirmOpen: Boolean = false,
) {
    /**
     * The persona a NEW conversation would get. Named in the persona sheet so the
     * switch reads as temporary: this conversation moves, the default does not.
     */
    val defaultPersonaName: String?
        get() = assistant?.defaultPersonaId?.let { id -> personas.find { it.id == id }?.name }
}

@HiltViewModel
class ChatViewModel @Inject constructor(
    private val application: Application,
    private val personaRepository: PersonaRepository,
    private val assistantRepository: AssistantRepository,
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

        // Load the assistant's default persona and its conversation
        viewModelScope.launch {
            val baseUrl = prefs.getBackendUrl()
            val alwaysListen = prefs.getAsrAlwaysListen()
            _state.update { it.copy(baseUrl = baseUrl, alwaysListen = alwaysListen) }

            try {
                val profile = authRepository.loadUserProfile()
                _state.update { it.copy(userAvatarUuid = profile.userAvatarUuid) }
            } catch (_: Exception) {}

            loadPersona()
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

    /**
     * Load the persona that answers by default, and its conversation.
     *
     * There is no local "selected persona": the assistant's `default_persona_id`
     * is the single source of truth, or two devices disagree about who answers.
     * The wake word comes off the assistant too — it is a voice trigger, not a
     * persona picker.
     */
    private suspend fun loadPersona() {
        try {
            val assistant = assistantRepository.getAssistant()
            voiceInteractionManager.setTriggerWord(assistant.triggerWord)

            val personas = personaRepository.listPersonas()
            val persona = personas.find { it.id == assistant.defaultPersonaId }
                ?: personas.firstOrNull { it.enabled }

            _state.update { it.copy(assistant = assistant, personas = personas, persona = persona) }

            if (persona != null) {
                coreState.setCurrentPersonaId(persona.id)

                val convId = personaRepository.getConversationIdForPersona(persona.id)
                if (convId != null) {
                    loadConversation(convId)
                } else {
                    _state.update { it.copy(messages = emptyList(), conversationId = null, hasMore = false) }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load persona/conversation", e)
        }
    }

    private suspend fun loadConversation(id: Int) {
        val detail = conversationRepository.getConversation(id, 20, 0)
        _state.update { s ->
            // The server owns the binding, so a per-conversation override survives
            // a reconnect, a process death and a second device. An unbound
            // conversation keeps whoever is already in the header.
            val bound = detail.personaId?.let { pid -> s.personas.find { it.id == pid } }
            s.copy(
                messages = detail.messages,
                conversationId = id,
                hasMore = detail.hasMore,
                isLoadingMore = false,
                persona = bound ?: s.persona,
            )
        }
        coreState.setConversationId(id)
        _state.value.persona?.let { coreState.setCurrentPersonaId(it.id) }
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
            "delete" -> requestDeleteConversation()
            "refresh" -> refreshConversation()
            "resume" -> openResumePicker()
            "persona" -> openPersonaSheet()
            "context" -> openContextDialog()
            "compact" -> compactContext()
        }
    }

    /**
     * Non-destructive: drop the conversation from view so the next send creates a new one
     * on the backend. Existing messages stay on the server and can be re-loaded via /resume.
     */
    fun clearCurrentConversation() {
        val personaId = _state.value.persona?.id
        viewModelScope.launch {
            if (personaId != null) personaRepository.clearConversationIdForPersona(personaId)
            _state.update { s ->
                // A new chat opens with the assistant's default persona, silently.
                // A per-conversation override belonged to the conversation that
                // just closed and must not follow the user into the next one.
                val default = s.assistant?.defaultPersonaId?.let { id -> s.personas.find { it.id == id } }
                s.copy(
                    messages = emptyList(),
                    conversationId = null,
                    hasMore = false,
                    persona = default ?: s.persona,
                    commandFeedback = "Started a new conversation",
                )
            }
            coreState.setConversationId(null)
            _state.value.persona?.let { coreState.setCurrentPersonaId(it.id) }
        }
    }

    private fun openResumePicker() {
        val personaId = _state.value.persona?.id
        _state.update { it.copy(modal = ChatModal.ResumePicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                val convs = conversationRepository.getConversations(personaId)
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

    /** Open the per-conversation persona switcher — header tap or `/persona`. */
    fun openPersonaSheet() {
        _state.update { it.copy(modal = ChatModal.PersonaPicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                // Sub-agents are task-only workers and never answer as anyone, so
                // there is nothing to filter out here — only personas are listed.
                val all = personaRepository.listPersonas()
                _state.update { it.copy(
                    personas = all,
                    modal = ChatModal.PersonaPicker(all.filter { p -> p.enabled }, loading = false),
                ) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load personas", e)
                _state.update { it.copy(
                    modal = null,
                    commandFeedback = "Failed to load personas",
                ) }
            }
        }
    }

    fun openContextDialog() {
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

    fun compactContext() {
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
                val personaId = _state.value.persona?.id
                if (personaId != null) {
                    personaRepository.setConversationIdForPersona(personaId, conversationId)
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

    /**
     * Rebind THIS conversation to [persona]. This conversation only.
     *
     * The switch writes `persona_id` on the conversation, so it persists with no
     * message sent and survives a reconnect. It deliberately does not touch the
     * assistant's `default_persona_id`: the next new chat still opens with the
     * default, which is the entire meaning of "this conversation only". Nor does
     * it move the wake word — that is assistant-level and selects no one.
     *
     * The transcript does not change: past messages keep the persona that
     * actually produced them.
     */
    fun switchPersona(persona: Persona) {
        val previous = _state.value.persona
        val convId = _state.value.conversationId

        // The header must not lag a tap, so the swap is optimistic and reverted
        // if the PATCH fails.
        _state.update { it.copy(persona = persona, modal = null) }
        coreState.setCurrentPersonaId(persona.id)

        if (convId == null) {
            // Nothing on the server to rebind yet — the first message will carry
            // this persona_id and create the conversation already bound.
            _state.update { it.copy(commandFeedback = "${persona.name} answers this chat") }
            return
        }

        viewModelScope.launch {
            try {
                conversationRepository.setConversationPersona(convId, persona.id)
                personaRepository.setConversationIdForPersona(persona.id, convId)
                _state.update { it.copy(commandFeedback = "${persona.name} answers this chat") }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to bind persona to conversation $convId", e)
                _state.update { it.copy(
                    persona = previous,
                    commandFeedback = "Could not switch persona",
                ) }
                previous?.let { coreState.setCurrentPersonaId(it.id) }
            }
        }
    }

    private fun doSend(text: String, images: List<String>) {
        val s = _state.value
        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(text, images)

        viewModelScope.launch {
            try {
                // Backend uses the assistant's configured model_name when modelName is empty.
                wsManager.sendChatRequest(
                    text = text,
                    modelName = "",
                    conversationId = s.conversationId,
                    personaId = s.persona?.id,
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

    /**
     * Ask before deleting. Deletion took the transcript and every tool result with
     * it on a single tap, from the toolbar and from `/delete` alike, with nothing
     * to undo it.
     */
    fun requestDeleteConversation() {
        if (_state.value.conversationId == null) {
            _state.update { it.copy(commandFeedback = "No conversation to delete") }
            return
        }
        _state.update { it.copy(deleteConfirmOpen = true) }
    }

    fun cancelDeleteConversation() = _state.update { it.copy(deleteConfirmOpen = false) }

    fun confirmDeleteConversation() {
        val convId = _state.value.conversationId
        _state.update { it.copy(deleteConfirmOpen = false) }
        if (convId == null) return
        viewModelScope.launch {
            try {
                conversationRepository.deleteConversation(convId)
                val personaId = _state.value.persona?.id
                if (personaId != null) personaRepository.clearConversationIdForPersona(personaId)
                _state.update { it.copy(
                    messages = emptyList(),
                    conversationId = null,
                    hasMore = false,
                    commandFeedback = "Conversation deleted",
                ) }
                coreState.setConversationId(null)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to delete conversation $convId", e)
                _state.update { it.copy(commandFeedback = "Could not delete the conversation") }
            }
        }
    }

    /** Drop out of voice mode from the composer's stop control. */
    fun stopVoiceMode() {
        if (voiceInteractionManager.state.value.isInteractionMode) {
            voiceInteractionManager.exitMode()
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

    override fun onCleared() {
        super.onCleared()
        if (voiceInteractionManager.state.value.isInteractionMode) {
            voiceInteractionManager.exitMode()
        }
        voiceInteractionManager.setTriggerWord(null)
        coreState.setCurrentPersonaId(null)
    }
}
