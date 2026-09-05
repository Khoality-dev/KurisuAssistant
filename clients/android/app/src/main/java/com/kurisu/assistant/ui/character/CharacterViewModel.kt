package com.kurisu.assistant.ui.character

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.PoseTree
import com.kurisu.assistant.data.model.VisionResultEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.domain.character.CharacterCompositor
import com.kurisu.assistant.domain.character.CompositorState
import com.kurisu.assistant.data.local.EncryptedPreferences
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
    val isLoading: Boolean = false,
    /** Set when the bound persona has no character configured, or the load failed. */
    val error: String? = null,
    val isTransitioningVideo: Boolean = false,
    val transitionVideoUrl: String? = null,
    val transitionPlaybackRate: Float = 1f,
    val subtitle: String? = null,
    // ExoPlayer fetches transition videos itself and does not share the app's
    // OkHttp interceptor chain, so it needs the token handed to it.
    val authToken: String? = null,
)

@HiltViewModel
class CharacterViewModel @Inject constructor(
    private val imageCache: ImageCache,
    private val wsManager: WebSocketManager,
    private val prefs: PreferencesDataStore,
    private val streamProcessor: ChatStreamProcessor,
    private val ttsQueueManager: TtsQueueManager,
    private val personaRepository: PersonaRepository,
    private val assistantRepository: AssistantRepository,
    private val encryptedPreferences: EncryptedPreferences,
) : ViewModel() {

    /** The persona whose character is currently loaded, so a rebind is a no-op. */
    private var boundPersonaId: Int? = null

    val compositor = CharacterCompositor(imageCache)

    private val _state = MutableStateFlow(CharacterUiState(authToken = encryptedPreferences.getToken()))
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

    }

    /**
     * Load the character belonging to [personaId] — the persona answering the open
     * conversation.
     *
     * This replaces a read of `savedStateHandle["agentId"]` against a route that
     * never carried an argument, so the id was always -1, the load never ran and
     * the screen sat on "Loading character…" forever. A null [personaId] means the
     * caller has no binding yet, so the assistant's default persona answers —
     * the same persona the next message would go to.
     */
    fun bindPersona(personaId: Int?) {
        if (personaId != null && personaId == boundPersonaId) return

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                val resolvedId = personaId ?: assistantRepository.getAssistant().defaultPersonaId
                if (resolvedId == null) {
                    _state.update { it.copy(isLoading = false, error = "No persona is answering this chat yet.") }
                    return@launch
                }
                boundPersonaId = resolvedId

                val configJson = personaRepository.getPersona(resolvedId).characterConfig?.toString()
                if (configJson == null) {
                    _state.update { it.copy(
                        isLoaded = false,
                        isLoading = false,
                        error = "This persona has no character configured.",
                    ) }
                    return@launch
                }
                loadCharacterConfig(configJson)
            } catch (e: Exception) {
                android.util.Log.e("CharacterVM", "Failed to load character config", e)
                boundPersonaId = null
                _state.update { it.copy(isLoading = false, error = "Could not load the character.") }
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
                if (poseTreeJson == null) {
                    _state.update { it.copy(
                        isLoaded = false,
                        isLoading = false,
                        error = "This persona has no character configured.",
                    ) }
                    return@launch
                }
                val poseTree = json.decodeFromJsonElement(PoseTree.serializer(), poseTreeJson)
                compositor.loadPoseTree(poseTree, baseUrl)
                _state.update { it.copy(isLoaded = true, isLoading = false, error = null) }
            } catch (e: Exception) {
                android.util.Log.e("CharacterVM", "Failed to load character config: ${e.message}")
                _state.update { it.copy(isLoading = false, error = "Could not load the character.") }
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
