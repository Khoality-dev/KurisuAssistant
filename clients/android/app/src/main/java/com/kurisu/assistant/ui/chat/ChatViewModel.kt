package com.kurisu.assistant.ui.chat

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.PermissionMode
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.ContextInfoEvent
import com.kurisu.assistant.data.model.ErrorEvent
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.data.model.WsErrorCodes
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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import javax.inject.Inject

/** Modal overlay surfaced from a slash command. Only one can be active at a time. */
sealed class ChatModal {
    data class ResumePicker(val conversations: List<Conversation>, val loading: Boolean = false) : ChatModal()
    data class PersonaPicker(val personas: List<Persona>, val loading: Boolean = false) : ChatModal()
    /** The assistant's model — one for every persona. A pick applies from the next message. */
    data class ModelPicker(val models: List<ModelInfo>, val loading: Boolean = false) : ChatModal()
    /** The account's permission mode, beside the input (#360). */
    data object PermissionModePicker : ChatModal()
    data class ContextDialog(
        val conversationId: Int?,
        val tokenCount: Int?,
        val compacting: Boolean,
        val compactedUpToId: Int,
        val compactedContext: String,
    ) : ChatModal()
}

/**
 * A voice-mode interaction's conversation (#341): when the wake word was heard,
 * the conversation that was open then (kept in Chats), and the new one once the
 * server has created it — null until then.
 */
data class InteractionMarker(
    val atMs: Long,
    val previousConversationId: Int?,
    val conversationId: Int? = null,
)

data class ChatUiState(
    /** The one assistant: model, permission mode, memory, wake word, and the persona in use. */
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
    val deleteConfirmOpen: Boolean = false,
    /** Voice mode was just turned off: a snackbar says the mic is off (#341). */
    val voiceOffNotice: Boolean = false,
    /** The conversation a voice-mode interaction opened, for the marker at its top (#341). */
    val interactionMarker: InteractionMarker? = null,
) {
    /** The marker belongs to the conversation on screen, or to the one about to be created. */
    val showInteractionMarker: Boolean
        get() = interactionMarker != null && interactionMarker.conversationId == conversationId


    /**
     * Who answers — the header names it: the persona in use for the whole
     * account (#354), while it is enabled, else nobody — the assistant itself, as
     * a persona is optional (#302). The server resolves it the same way; a turn
     * never names it. Every conversation, this one included, answers as it.
     */
    val persona: Persona?
        get() = assistant?.selectedPersonaId?.let { id -> personas.find { it.id == id && it.enabled } }
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

        /** What the assistant is called when it answers as itself — the server's name for it. */
        const val ASSISTANT_NAME = "Assistant"

        /** The backend's default `MAX_IMAGE_BYTES` (`utils/images.py`). */
        const val MAX_IMAGE_BYTES = 16 * 1024 * 1024
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

        // Load who the chat is on, and their conversation
        viewModelScope.launch {
            val baseUrl = prefs.getBackendUrl()
            _state.update { it.copy(baseUrl = baseUrl) }
            // Voice mode comes back on if this device left it on (#341); the
            // service starts the mic from the same setting.
            if (prefs.getVoiceMode()) voiceInteractionManager.setVoiceMode(true)

            try {
                val profile = authRepository.loadUserProfile()
                _state.update { it.copy(userAvatarUuid = profile.userAvatarUuid) }
            } catch (_: Exception) {}

            loadAssistant()
        }

        // Observe service state for conversation ID sync
        viewModelScope.launch {
            coreState.state.collect { svcState ->
                val currentConvId = _state.value.conversationId
                val serviceConvId = svcState.conversationId
                if (serviceConvId != null && serviceConvId != currentConvId) {
                    // An interaction's new conversation, now that the server has
                    // made it: the marker stays with it.
                    _state.update { s ->
                        val marker = s.interactionMarker
                        s.copy(
                            conversationId = serviceConvId,
                            interactionMarker = if (marker != null && marker.conversationId == null && currentConvId == null) {
                                marker.copy(conversationId = serviceConvId)
                            } else marker,
                        )
                    }
                    loadConversation(serviceConvId)
                }
            }
        }

        // Observe tool approval requests, and the one refusal worth undoing
        viewModelScope.launch {
            wsManager.events.collect { event ->
                if (event is ToolApprovalRequestEvent) {
                    _state.update { it.copy(pendingApproval = event) }
                }
                // A turn refused for having no model was rejected before the server
                // saved anything, so the message is only lost if we drop it. Put it
                // back in the box the user is looking at, next to the prompt that
                // says what to do (#149). Desktop does the same.
                if (event is ErrorEvent && event.code == WsErrorCodes.NO_MODEL_SELECTED) {
                    // From the stream processor, not a field of our own: a voice send
                    // goes through CoreService and never touches this ViewModel, so a
                    // local copy would hand back whatever was typed before it.
                    val text = streamProcessor.lastUserMessageText
                    if (text.isNotEmpty()) {
                        _state.update { if (it.inputText.isEmpty()) it.copy(inputText = text) else it }
                    }
                }
            }
        }

        // The wake word started an interaction, and each is a new conversation
        // (#341): leave this one — it stays in Chats — and mark the new one.
        viewModelScope.launch {
            coreState.newInteractions.collect { atMs ->
                _state.update { it.copy(
                    interactionMarker = InteractionMarker(atMs = atMs, previousConversationId = it.conversationId),
                    conversationId = null,
                    messages = emptyList(),
                    hasMore = false,
                ) }
            }
        }

        // A failed transcription or synthesis lands in the same banner as a failed
        // send: it is the chat that went quiet, and this is where the user is.
        viewModelScope.launch {
            coreState.speechErrors.collect { message -> streamProcessor.setError(message) }
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
     * Load the assistant and the personas: who answers comes from them.
     *
     * There is no local "selected persona": the assistant's `selected_persona_id`
     * is the single source of truth, or two devices disagree about who answers.
     * With none selected — where every account starts — the assistant answers as
     * itself, and there is no falling back to "the first persona" (#302). The
     * wake word comes off the assistant too — it is a voice trigger, not a
     * persona picker.
     *
     * The conversation is not chosen here: it is the one the Chats list put on
     * [CoreState] (null for a new chat), loaded by the observer in `init`. There
     * is no per-persona memory of conversations any more (#354).
     */
    private suspend fun loadAssistant() {
        try {
            val assistant = assistantRepository.getAssistant()
            voiceInteractionManager.setTriggerWord(assistant.triggerWord)

            val personas = personaRepository.listPersonas()
            _state.update { it.copy(assistant = assistant, personas = personas) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load the assistant", e)
        }
    }

    /** Load a conversation. It carries no persona: who answers is the account's (#354). */
    private suspend fun loadConversation(id: Int) {
        val detail = conversationRepository.getConversation(id, 20, 0)
        _state.update { s ->
            s.copy(
                messages = detail.messages,
                conversationId = id,
                hasMore = detail.hasMore,
                isLoadingMore = false,
            )
        }
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

        // The composer's content:// URIs, kept as strings until the send: the
        // bubble shows them at once and they are read and encoded only then.
        val images = s.selectedImages.map { it.toString() }
        _state.update { it.copy(inputText = "", selectedImages = emptyList()) }

        // If currently streaming, queue the message
        if (streamProcessor.state.value.isStreaming) {
            streamProcessor.queueMessage(messageText, images)
            return
        }

        doSend(messageText, images)
    }

    /** Where attached images are read. Overridable so a test can run it on its own scheduler. */
    internal var ioDispatcher: CoroutineDispatcher = Dispatchers.IO

    private class ImageTooLarge : IOException()

    /**
     * One attached image as the backend takes it in `chat_request.images`:
     * base64, as the desktop sends it (#308). Refused past the backend's own
     * ceiling, which would otherwise drop it with only a log line.
     */
    private fun readImageBase64(uri: String): String {
        val input = application.contentResolver.openInputStream(Uri.parse(uri))
            ?: throw IOException("No stream for $uri")
        val bytes = input.use { stream ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val n = stream.read(buffer)
                if (n < 0) break
                total += n
                if (total > MAX_IMAGE_BYTES) throw ImageTooLarge()
                out.write(buffer, 0, n)
            }
            out.toByteArray()
        }
        return Base64.getEncoder().encodeToString(bytes)
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
        // A new chat answers as the persona in use, like every other (#354).
        _state.update { s ->
            s.copy(
                messages = emptyList(),
                conversationId = null,
                hasMore = false,
                commandFeedback = "Started a new conversation",
            )
        }
        coreState.setConversationId(null)
    }

    private fun openResumePicker() {
        _state.update { it.copy(modal = ChatModal.ResumePicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                val convs = conversationRepository.getConversations()
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

    /** Open the persona switcher — header tap or `/persona`. The switch is the account's (#354). */
    fun openPersonaSheet() {
        _state.update { it.copy(modal = ChatModal.PersonaPicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
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

    /**
     * Open the model sheet — the model name on the header, or "Choose a model"
     * on the no-model prompt (#197).
     *
     * The model is the ASSISTANT's: one for every persona, so the sheet says so
     * and a pick lands on `PATCH /assistant`, never on this conversation. It
     * applies from the next message, which is why nothing here is optimistic —
     * there is no header to keep from lagging, only a name to update once the
     * server agrees.
     */
    fun openModelSheet() {
        _state.update { it.copy(modal = ChatModal.ModelPicker(emptyList(), loading = true)) }
        viewModelScope.launch {
            try {
                val models = assistantRepository.listModels()
                _state.update { it.copy(modal = ChatModal.ModelPicker(models, loading = false)) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load models", e)
                _state.update { it.copy(modal = null, commandFeedback = "Could not load models") }
            }
        }
    }

    /**
     * The provider travels with the model: they are two columns describing one
     * choice, and the name alone would point the assistant at a model the old
     * provider cannot serve.
     */
    fun pickModel(model: ModelInfo) {
        val current = _state.value.assistant
        if (model.name == current?.modelName && model.provider == current?.providerType) {
            _state.update { it.copy(modal = null) }
            return
        }
        viewModelScope.launch {
            try {
                val updated = assistantRepository.updateAssistant(
                    AssistantUpdate(modelName = model.name, providerType = model.provider),
                )
                _state.update {
                    it.copy(assistant = updated, modal = null, commandFeedback = "Model \u2192 ${model.name}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to change model", e)
                _state.update { it.copy(modal = null, commandFeedback = "Could not change model") }
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
     * Voice mode on or off, from the top bar or the voice bar (#341). It is the
     * only time the mic listens, and it replaced "Always listen": this device
     * remembers it. Turning it off ends any interaction, stops the mic, and says so.
     */
    fun setVoiceMode(on: Boolean) {
        voiceInteractionManager.setVoiceMode(on)
        _state.update { it.copy(voiceOffNotice = !on) }
        try {
            com.kurisu.assistant.service.CoreService.requestVoiceMode(application, coreState, on)
        } catch (e: Exception) {
            Log.e(TAG, "Could not reach the voice service", e)
        }
        viewModelScope.launch {
            try { prefs.setVoiceMode(on) } catch (e: Exception) {
                Log.e(TAG, "Failed to persist voice mode", e)
            }
        }
    }

    fun dismissVoiceOffNotice() = _state.update { it.copy(voiceOffNotice = false) }

    /** The voice bar's "Try again" / "Retry": start the mic again. */
    fun retryMic() {
        try {
            com.kurisu.assistant.service.CoreService.requestMicRetry(application, coreState)
        } catch (e: Exception) {
            Log.e(TAG, "Could not reach the voice service", e)
        }
    }

    /**
     * The chat is back in front — perhaps from Android settings, where mic access
     * was just allowed. If that was what stopped voice mode, try again.
     */
    fun onResume() {
        val blocked = coreState.state.value.micProblem == com.kurisu.assistant.domain.voice.MicProblem.BLOCKED
        if (voiceInteractionManager.state.value.voiceMode && blocked &&
            com.kurisu.assistant.service.CoreService.hasMicPermission(application)
        ) {
            retryMic()
        }
    }

    fun resumeConversation(conversationId: Int) {
        viewModelScope.launch {
            try {
                loadConversation(conversationId)
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
     * The permission mode sheet (#360). It refetches the assistant as it opens,
     * so a mode changed on another device shows: the mode is the account's.
     */
    fun openPermissionModeSheet() {
        _state.update { it.copy(modal = ChatModal.PermissionModePicker) }
        viewModelScope.launch {
            try {
                val fresh = assistantRepository.getAssistant()
                _state.update { it.copy(assistant = fresh) }
            } catch (e: Exception) {
                Log.w(TAG, "Could not refresh the assistant for the permission mode", e)
            }
        }
    }

    /**
     * Change what the assistant may do without asking, for the whole account,
     * on every device and in background tasks (#360). Optimistic, so the chip
     * does not lag a tap, and rolled back when the server refuses.
     */
    fun setPermissionMode(mode: PermissionMode) {
        val previous = _state.value.assistant ?: return
        _state.update { if (it.modal == ChatModal.PermissionModePicker) it.copy(modal = null) else it }
        if (previous.permissionMode == mode) return
        _state.update { it.copy(assistant = previous.copy(permissionMode = mode)) }
        viewModelScope.launch {
            try {
                val updated = assistantRepository.updateAssistant(AssistantUpdate(permissionMode = mode))
                _state.update { it.copy(assistant = updated) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to change the permission mode", e)
                _state.update { it.copy(
                    assistant = it.assistant?.copy(permissionMode = previous.permissionMode),
                    commandFeedback = "Could not change the permission mode",
                ) }
            }
        }
    }

    /**
     * Put [persona] in use for the whole account — or, with null, the assistant
     * itself (#302) — through the assistant's `selected_persona_id` (#354).
     *
     * Every conversation answers as it from the next turn on, this one included,
     * on every device: the open conversation stays open and continues as the new
     * persona. The wake word does not move — it is assistant-level and selects
     * no one. Past messages keep the persona that actually produced them.
     */
    fun switchPersona(persona: Persona?) {
        val previous = _state.value.assistant ?: return
        val answers = "${persona?.name ?: ASSISTANT_NAME} answers every chat"

        // The header must not lag a tap, so the swap is optimistic and reverted
        // if the PATCH fails.
        _state.update { it.copy(assistant = previous.copy(selectedPersonaId = persona?.id), modal = null) }

        viewModelScope.launch {
            try {
                val updated = if (persona == null) {
                    assistantRepository.clearSelectedPersona()
                } else {
                    assistantRepository.updateAssistant(AssistantUpdate(selectedPersonaId = persona.id))
                }
                _state.update { it.copy(assistant = updated, commandFeedback = answers) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to switch the persona in use", e)
                _state.update { it.copy(
                    assistant = previous,
                    commandFeedback = "Could not switch persona",
                ) }
            }
        }
    }

    /**
     * Send one turn. [images] are the attachments' URIs: the bubble shows them
     * as they are, and the request carries their bytes. A turn without images
     * starts streaming synchronously, as it always has.
     */
    private fun doSend(text: String, images: List<String>) {
        if (images.isEmpty()) {
            startTurn(text, images, emptyList())
            return
        }
        viewModelScope.launch {
            val encoded = try {
                withContext(ioDispatcher) { images.map(::readImageBase64) }
            } catch (e: Exception) {
                Log.w(TAG, "Could not read an attached image", e)
                // Nothing was sent: give the draft back rather than lose it.
                _state.update { it.copy(inputText = text, selectedImages = images.map(Uri::parse)) }
                streamProcessor.setError(
                    if (e is ImageTooLarge) "The attached image is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB."
                    else "Couldn't read the attached image."
                )
                return@launch
            }
            startTurn(text, images, encoded)
        }
    }

    private fun startTurn(text: String, previews: List<String>, images: List<String>) {
        val s = _state.value
        streamProcessor.startStreaming()
        streamProcessor.addUserMessage(text, previews)

        viewModelScope.launch {
            try {
                // Backend uses the assistant's configured model_name when modelName is empty.
                wsManager.sendChatRequest(
                    text = text,
                    modelName = "",
                    // No persona: the server answers as the one in use (#354).
                    conversationId = s.conversationId,
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
                // What follows is a new chat.
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
        voiceInteractionManager.setTriggerWord(null)
    }
}
