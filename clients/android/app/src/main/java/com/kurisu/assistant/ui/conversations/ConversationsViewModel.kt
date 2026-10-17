package com.kurisu.assistant.ui.conversations

import android.app.Application
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.service.VoiceInteractionManager
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
 * A conversation is not tied to a persona (#354): one persona, or none, is in
 * use for the whole account and answers every conversation, so the row has no
 * face and no name to show. Each reply's bubble names who gave it.
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
    /** Written by a task run (#352), not by the user in a chat: drawn with a clock. */
    val taskRun: Boolean = false,
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
 * everything else the user had ever said. A conversation carries no persona at
 * all now (#354), so the list is a plain list of conversations.
 */
@HiltViewModel
class ConversationsViewModel @Inject constructor(
    private val application: Application,
    private val assistantRepository: AssistantRepository,
    private val conversationRepository: ConversationRepository,
    private val prefs: PreferencesDataStore,
    private val coreState: CoreState,
    private val updateRepository: UpdateRepository,
    private val voiceInteractionManager: VoiceInteractionManager,
) : ViewModel() {

    companion object {
        private const val TAG = "ConversationsViewModel"
    }

    private val _state = MutableStateFlow(ConversationsUiState())
    val state: StateFlow<ConversationsUiState> = _state

    val coreServiceState = coreState.state

    /**
     * The wake word started an interaction, in voice mode: open the chat, where
     * its new conversation is (#341). It carries no persona because it selects
     * none.
     */
    private val _wakeWord = MutableSharedFlow<Long>(extraBufferCapacity = 1)
    val wakeWord: SharedFlow<Long> = _wakeWord

    val voiceState = voiceInteractionManager.state

    init {
        load()
        checkForUpdate()

        viewModelScope.launch {
            coreState.newInteractions.collect { atMs -> _wakeWord.tryEmit(atMs) }
        }
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                // The assistant is a bonus here — it supplies the wake word —
                // so losing it must not lose the list.
                val assistant = runCatching { assistantRepository.getAssistant() }.getOrNull()

                val rows = conversationRepository.getConversations().map { conv ->
                    ConversationRowUi(
                        id = conv.id,
                        title = conv.title.ifBlank { "New conversation" },
                        preview = conv.lastMessage?.content?.takeIf { it.isNotBlank() },
                        timestamp = conv.lastMessage?.createdAt
                            ?: conv.updatedAt.takeIf { it.isNotBlank() },
                        taskRun = conv.taskRun,
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

    /** Voice mode on or off from the strip (#341); this device remembers it. */
    fun toggleVoiceMode() {
        val on = !voiceInteractionManager.state.value.voiceMode
        voiceInteractionManager.setVoiceMode(on)
        CoreService.requestVoiceMode(application, coreState, on)
        viewModelScope.launch { prefs.setVoiceMode(on) }
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
     * `conversation_id`, and answers it as the persona in use for the whole
     * account, or the assistant itself when there is none (#302, #354). All this
     * does is leave the open conversation, before the chat is shown — it opens
     * whatever [CoreState] names.
     */
    fun startNewChat(onReady: () -> Unit = {}) {
        coreState.setConversationId(null)
        onReady()
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
