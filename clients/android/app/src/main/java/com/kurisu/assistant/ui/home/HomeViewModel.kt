package com.kurisu.assistant.ui.home

import android.app.Application
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Agent
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.ConversationRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.service.CoreState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.io.File
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
    val updateRelease: GithubRelease? = null,
    val updateProgress: Float? = null,
    val updateApkFile: File? = null,
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
    private val coreState: CoreState,
    private val updateRepository: UpdateRepository,
) : ViewModel() {

    companion object {
        private const val TAG = "HomeViewModel"
    }

    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state

    val coreServiceState = coreState.state

    private val _triggerMatch = MutableSharedFlow<TriggerMatch>(extraBufferCapacity = 1)
    val triggerMatch: SharedFlow<TriggerMatch> = _triggerMatch

    init {
        loadConversations()
        checkForUpdate()

        // Observe ASR transcripts from CoreState for trigger word matching across all agents
        viewModelScope.launch {
            coreState.asrTranscripts.collect { text ->
                val match = _state.value.conversations.find { conv ->
                    conv.agent.triggerWord != null &&
                        text.lowercase().contains(conv.agent.triggerWord!!.lowercase())
                }
                if (match != null) {
                    _triggerMatch.tryEmit(TriggerMatch(match.agent.id, text))
                }
            }
        }
    }

    fun toggleService() {
        if (coreState.state.value.isServiceRunning) {
            CoreService.stop(application)
        } else {
            CoreService.start(application)
        }
    }

    fun startService() {
        CoreService.start(application)
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

    private fun checkForUpdate() {
        viewModelScope.launch {
            try {
                val release = updateRepository.checkForUpdate()
                if (release != null) {
                    _state.update { it.copy(updateRelease = release) }
                }
            } catch (e: Exception) {
                Log.d(TAG, "Update check failed: ${e.message}")
            }
        }
    }

    fun downloadAndInstall() {
        val release = _state.value.updateRelease ?: return
        val apkAsset = release.assets.firstOrNull { it.name.endsWith(".apk") } ?: return

        viewModelScope.launch {
            _state.update { it.copy(updateProgress = 0f) }
            try {
                val file = updateRepository.downloadApk(apkAsset.browserDownloadUrl) { progress ->
                    _state.update { it.copy(updateProgress = progress) }
                }
                _state.update { it.copy(updateApkFile = file, updateProgress = 1f) }
            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                _state.update { it.copy(updateProgress = null) }
            }
        }
    }

    fun dismissUpdate() {
        _state.update { it.copy(updateRelease = null, updateProgress = null, updateApkFile = null) }
    }
}
