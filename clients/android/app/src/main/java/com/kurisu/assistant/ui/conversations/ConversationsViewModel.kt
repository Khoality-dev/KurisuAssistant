package com.kurisu.assistant.ui.conversations

import android.app.Application
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.ui.update.installApk
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/**
 * One row of the Chats list: a CONVERSATION, and nothing about who answers it.
 *
 * There is one assistant with one default persona, so a face and a name on the
 * row were the same face and the same name on every row — they distinguished
 * nothing and cost the title its width. A conversation says who answers it in
 * the chat header, where the per-conversation override lives.
 *
 * The assistant's model is absent for the same reason.
 */
data class ConversationRowUi(
    val id: Int,
    val title: String,
    val preview: String?,
    /**
     * ISO-8601 instant of the last activity, NOT a formatted label: the label is
     * computed at render time so a row that stays on screen keeps ageing.
     */
    val timestamp: String?,
)

data class ConversationsUiState(
    val rows: List<ConversationRowUi> = emptyList(),
    /** True until the first load settles, so the first frame is a spinner. */
    val isLoading: Boolean = true,
    val error: String? = null,
    /**
     * The assistant's voice WAKE word. It selects no persona — it only wakes the
     * assistant — and it is shown in the mic strip so the user knows what to say.
     */
    val triggerWord: String? = null,
    val updateRelease: GithubRelease? = null,
    val updateProgress: Float? = null,
    val updateApkFile: File? = null,
)

/**
 * The Chats list.
 *
 * Rows are conversations. The dead Home screen listed PERSONAS and hung one
 * conversation off each, which could show at most one chat per persona and hid
 * everything else the user had ever said; `Conversation.persona_id` now exists
 * on the model, so a conversation can name its own persona and the list is a
 * plain list of conversations again.
 *
 * It does not draw that persona. With one assistant the rows all resolve to the
 * same one, so the face and the name said nothing five times over (#192).
 */
@HiltViewModel
class ConversationsViewModel @Inject constructor(
    private val application: Application,
    private val personaRepository: PersonaRepository,
    private val assistantRepository: AssistantRepository,
    private val conversationRepository: ConversationRepository,
    private val prefs: PreferencesDataStore,
    private val coreState: CoreState,
    private val updateRepository: UpdateRepository,
) : ViewModel() {

    companion object {
        private const val TAG = "ConversationsViewModel"
    }

    private val _state = MutableStateFlow(ConversationsUiState())
    val state: StateFlow<ConversationsUiState> = _state

    val coreServiceState = coreState.state

    /**
     * The wake word was heard: open the chat. It carries no persona because it
     * selects none — whoever the conversation is bound to answers.
     */
    private val _wakeWord = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val wakeWord: SharedFlow<String> = _wakeWord

    @Volatile private var triggerWord: String? = null
    @Volatile private var defaultPersonaId: Int? = null

    init {
        load()
        checkForUpdate()

        viewModelScope.launch {
            coreState.asrTranscripts.collect { text ->
                val word = triggerWord ?: return@collect
                if (text.contains(word, ignoreCase = true)) {
                    _wakeWord.tryEmit(text)
                }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                // No row names a persona any more, so the persona list is read
                // for one thing: which persona a new chat will take. The chat
                // screen resolves it with this same rule, and the two must agree
                // or `startNewChat` clears the wrong cached conversation.
                val personas = personaRepository.listPersonas()

                // The assistant is a bonus here — it supplies the wake word and
                // the default persona — so losing it must not lose the list.
                val assistant = runCatching { assistantRepository.getAssistant() }.getOrNull()
                triggerWord = assistant?.triggerWord
                defaultPersonaId = assistant?.defaultPersonaId
                    ?: personas.firstOrNull { it.enabled }?.id

                val rows = conversationRepository.getConversations().map { conv ->
                    ConversationRowUi(
                        id = conv.id,
                        title = conv.title.ifBlank { "New conversation" },
                        preview = conv.lastMessage?.content?.takeIf { it.isNotBlank() },
                        timestamp = conv.lastMessage?.createdAt
                            ?: conv.updatedAt.takeIf { it.isNotBlank() },
                    )
                }.sortedByDescending { it.timestamp ?: "" }

                _state.update {
                    it.copy(
                        rows = rows,
                        isLoading = false,
                        error = null,
                        triggerWord = assistant?.triggerWord,
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load conversations", e)
                _state.update {
                    it.copy(
                        isLoading = false,
                        error = e.message?.takeIf { m -> m.isNotBlank() }
                            ?: "Could not reach the server",
                    )
                }
            }
        }
    }

    fun toggleRecording() {
        if (coreState.state.value.isServiceRunning) {
            CoreService.toggleRecording(application)
        } else {
            CoreService.start(application)
        }
    }

    fun startService() {
        CoreService.start(application)
    }

    /**
     * Open an existing conversation. The id goes through [CoreState] because
     * that is how the chat already learns which conversation it is in — the
     * service writes it there too.
     */
    fun openConversation(id: Int) {
        coreState.setConversationId(id)
    }

    /**
     * Start a new chat. There is no picker and no create call: the backend makes
     * the conversation when the first message arrives with a null
     * `conversation_id`, and binds it to `assistants.default_persona_id`. All
     * this does is make sure nothing stale is resumed instead.
     */
    fun startNewChat(onReady: () -> Unit = {}) {
        viewModelScope.launch {
            defaultPersonaId?.let { personaRepository.clearConversationIdForPersona(it) }
            coreState.setConversationId(null)
            // Navigating before the clear lands would let the chat's own load
            // read the stale cached id and resume the previous conversation, so
            // the caller is released here rather than at the call site.
            onReady()
        }
    }

    // ---- In-app update ---------------------------------------------------
    // Carried over from the deleted ui/home. This is the launch-time check;
    // Settings and About own the manual one. Without it, deleting ui/home would
    // have left the hard version gate in MainActivity as the only update path.

    private fun checkForUpdate() {
        viewModelScope.launch {
            try {
                val release = updateRepository.checkForUpdate()
                if (release != null) {
                    val auto = prefs.getAutoUpdate()
                    _state.update { it.copy(updateRelease = release) }
                    if (auto) downloadAndInstall(autoInstall = true)
                }
            } catch (e: Exception) {
                Log.d(TAG, "Update check failed: ${e.message}")
            }
        }
    }

    fun downloadAndInstall(autoInstall: Boolean = false) {
        val release = _state.value.updateRelease ?: return
        val apkAsset = release.assets.firstOrNull { it.name.endsWith(".apk") } ?: return

        viewModelScope.launch {
            _state.update { it.copy(updateProgress = 0f) }
            try {
                val file = updateRepository.downloadApk(apkAsset.browserDownloadUrl) { progress ->
                    _state.update { it.copy(updateProgress = progress) }
                }
                _state.update { it.copy(updateApkFile = file, updateProgress = 1f) }
                if (autoInstall) {
                    // The system prompts for REQUEST_INSTALL_PACKAGES if needed.
                    try {
                        installApk(application, file)
                    } catch (e: Exception) {
                        Log.e(TAG, "Auto-install failed; user can still tap Install", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                _state.update { it.copy(updateProgress = null) }
            }
        }
    }

    fun dismissUpdate() {
        _state.update {
            it.copy(updateRelease = null, updateProgress = null, updateApkFile = null)
        }
    }
}
