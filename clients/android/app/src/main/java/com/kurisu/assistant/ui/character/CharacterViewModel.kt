package com.kurisu.assistant.ui.character

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.PoseTree
import com.kurisu.assistant.data.model.VisionResultEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.domain.character.CharacterCompositor
import com.kurisu.assistant.domain.character.CompositorState
import com.kurisu.assistant.domain.character.ImageCache
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.tts.TtsQueueManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import javax.inject.Inject

data class CharacterUiState(
    val isLoaded: Boolean = false,
    val isTransitioningVideo: Boolean = false,
    val transitionVideoUrl: String? = null,
    val transitionPlaybackRate: Float = 1f,
    val subtitle: String? = null,
)

@HiltViewModel
class CharacterViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val imageCache: ImageCache,
    private val wsManager: WebSocketManager,
    private val prefs: PreferencesDataStore,
    private val streamProcessor: ChatStreamProcessor,
    private val ttsQueueManager: TtsQueueManager,
    private val agentRepository: AgentRepository,
) : ViewModel() {

    private val navAgentId: Int = savedStateHandle["agentId"] ?: -1

    val compositor = CharacterCompositor(imageCache)

    private val _state = MutableStateFlow(CharacterUiState())
    val state: StateFlow<CharacterUiState> = _state

    private val json = Json { ignoreUnknownKeys = true }

    // Stored callback from compositor to switch pose when video ends
    private var transitionOnComplete: (() -> Unit)? = null

    init {
        // Drive compositor from TTS amplitude + subtitle
        viewModelScope.launch {
            ttsQueueManager.state.collect { ttsState ->
                compositor.mouthAmplitude = ttsState.amplitude
                compositor.isAudioPlaying = ttsState.isPlaying
                _state.update { it.copy(subtitle = ttsState.currentText) }
            }
        }

        // Drive compositor from streaming thinking state
        viewModelScope.launch {
            streamProcessor.state.collect { streamState ->
                compositor.isThinking = streamState.isStreaming
            }
        }

        // Vision results → gestures/faces
        viewModelScope.launch {
            wsManager.events
                .filterIsInstance<VisionResultEvent>()
                .collect { event ->
                    compositor.setGestures(event.gestures.map { it.gesture })
                    compositor.setFaces(event.faces.mapNotNull { it.name.ifBlank { null } })
                }
        }

        // Video transition callback
        compositor.onTransitionVideo = { url, rate, onComplete ->
            transitionOnComplete = onComplete
            _state.update { it.copy(
                isTransitioningVideo = true,
                transitionVideoUrl = url,
                transitionPlaybackRate = rate,
            ) }
        }

        // Auto-load character config from nav arg agent
        if (navAgentId > 0) {
            viewModelScope.launch {
                try {
                    val agents = agentRepository.loadAgents()
                    val agent = agents.find { it.id == navAgentId }
                    val configJson = agent?.characterConfig?.toString()
                    if (configJson != null) {
                        loadCharacterConfig(configJson)
                    }
                } catch (e: Exception) {
                    android.util.Log.e("CharacterVM", "Failed to auto-load character config", e)
                }
            }
        }
    }

    fun loadCharacterConfig(configJson: String) {
        viewModelScope.launch {
            try {
                val baseUrl = prefs.getBackendUrl()
                // Parse the pose_tree from the character_config JSON
                val jsonObj = json.parseToJsonElement(configJson).jsonObject
                val poseTreeJson = jsonObj["pose_tree"]
                if (poseTreeJson != null) {
                    val poseTree = json.decodeFromJsonElement(PoseTree.serializer(), poseTreeJson)
                    compositor.loadPoseTree(poseTree, baseUrl)
                    _state.update { it.copy(isLoaded = true) }
                }
            } catch (e: Exception) {
                android.util.Log.e("CharacterVM", "Failed to load character config: ${e.message}")
            }
        }
    }

    /** Called when video playback ends — switch pose underneath before fade-out starts */
    fun onTransitionVideoEnded() {
        transitionOnComplete?.invoke()
        transitionOnComplete = null
    }

    /** Called after fade-out animation completes — clean up video player */
    fun onTransitionVideoFadeOutComplete() {
        _state.update { it.copy(isTransitioningVideo = false, transitionVideoUrl = null) }
    }

    override fun onCleared() {
        super.onCleared()
        compositor.clearPose()
        imageCache.clear()
    }
}
