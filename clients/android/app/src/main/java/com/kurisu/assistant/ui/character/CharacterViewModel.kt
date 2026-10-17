package com.kurisu.assistant.ui.character

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.PoseTree
import com.kurisu.assistant.data.model.VisionResultEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.PersonaRepository
import com.kurisu.assistant.domain.character.CharacterCompositor
import com.kurisu.assistant.domain.character.CharacterConfigKind
import com.kurisu.assistant.domain.character.CompositorState
import com.kurisu.assistant.domain.character.unrenderableMessage
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.domain.character.ImageCache
import com.kurisu.assistant.domain.chat.ChatStreamProcessor
import com.kurisu.assistant.domain.character.vrm.BridgeMessages
import com.kurisu.assistant.domain.character.vrm.CharacterAssetResolver
import com.kurisu.assistant.domain.character.vrm.OkHttpCharacterAssetFetcher
import com.kurisu.assistant.domain.character.vrm.VrmAssetRefs
import com.kurisu.assistant.domain.character.vrm.VrmFeed
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.ui.character.vrm.AuthedCharacterAssetHandler
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
    /** Which system draws the loaded character: the 2D compositor, or the 3D page (#246). */
    val kind: CharacterConfigKind = CharacterConfigKind.NONE,
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
    private val encryptedPreferences: EncryptedPreferences,
    okHttpClient: OkHttpClient,
    @ApplicationContext context: Context,
) : ViewModel() {

    /** The persona whose character is currently loaded, so a rebind is a no-op. */
    private var boundPersonaId: Int? = null

    val compositor = CharacterCompositor(imageCache)

    /** What the 3D page is told; the sheet's WebView follows it (#246). */
    val vrmFeed = VrmFeed()

    @Volatile private var backendUrl: String = ""

    /** The page's `/character-assets/` requests, answered from the device or with the app's own client. */
    private val assetResolver = CharacterAssetResolver(
        cacheDir = File(context.cacheDir, "character"),
        fetcher = OkHttpCharacterAssetFetcher(okHttpClient) { backendUrl },
    )
    val assetHandler = AuthedCharacterAssetHandler(assetResolver)

    /** Rises with every camera result, so the page takes each burst of gestures once. */
    private var gestureSeq = 0L

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

        // The 3D page clocks the mouth itself: one message per sentence, the
        // player's position twice a second, and the subtitle with its sentence.
        viewModelScope.launch {
            ttsQueueManager.state.map { it.currentSegment }.distinctUntilChanged { a, b -> a === b }.collect { segment ->
                vrmFeed.send(BridgeMessages.speech(segment))
                if (segment != null) vrmFeed.send(BridgeMessages.subtitle(segment.text, isUser = false, durationMs = segment.durationMs))
            }
        }
        viewModelScope.launch {
            ttsQueueManager.state.mapNotNull { it.speechSync }.distinctUntilChanged().collect { sync ->
                vrmFeed.send(BridgeMessages.speechSync(sync))
            }
        }

        // Drive compositor from streaming thinking state
        viewModelScope.launch {
            streamProcessor.state.collect { streamState ->
                compositor.isThinking = streamState.isStreaming
            }
        }
        viewModelScope.launch {
            streamProcessor.state.map { it.isStreaming }.distinctUntilChanged().collect { thinking ->
                vrmFeed.send(BridgeMessages.feed(isThinking = thinking))
            }
        }

        // Vision results → gestures/faces
        viewModelScope.launch {
            wsManager.events
                .filterIsInstance<VisionResultEvent>()
                .collect { event ->
                    val gestures = event.gestures.map { it.gesture }
                    val faces = event.faces.mapNotNull { it.name.ifBlank { null } }
                    compositor.setGestures(gestures)
                    compositor.setFaces(faces)
                    vrmFeed.send(BridgeMessages.gestures(gestures, seq = ++gestureSeq))
                    vrmFeed.send(BridgeMessages.faces(faces))
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
     * Load the character belonging to [personaId] — the persona in use for the
     * whole account (#354), which answers the open conversation like every other.
     *
     * This replaces a read of `savedStateHandle["agentId"]` against a route that
     * never carried an argument, so the id was always -1, the load never ran and
     * the screen sat on "Loading character…" forever. A null [personaId] is the
     * assistant answering as itself (#302): it has no character, and the screen
     * says so rather than borrowing another persona's.
     */
    fun bindPersona(personaId: Int?) {
        if (personaId != null && personaId == boundPersonaId) return

        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            try {
                if (personaId == null) {
                    boundPersonaId = null
                    _state.update {
                        it.copy(isLoading = false, error = "The assistant is answering as itself, with no persona or character.")
                    }
                    return@launch
                }
                val resolvedId: Int = personaId
                boundPersonaId = resolvedId

                val persona = personaRepository.getPersona(resolvedId)
                loadCharacterConfig(persona.characterConfig, resolvedId, persona.name)
            } catch (e: Exception) {
                android.util.Log.e("CharacterVM", "Failed to load character config", e)
                boundPersonaId = null
                _state.update { it.copy(isLoading = false, error = "Could not load the character.") }
            }
        }
    }

    /**
     * Draw what the config names, or say why not: a pose graph on the 2D
     * compositor, a VRM in the character page (#246), whose model the page asks
     * for and [assetHandler] answers.
     */
    fun loadCharacterConfig(config: JsonObject?, personaId: Int, personaName: String?) {
        viewModelScope.launch {
            try {
                val baseUrl = prefs.getBackendUrl()
                backendUrl = baseUrl
                val kind = CharacterConfigKind.of(config)
                val cannotDraw = kind.unrenderableMessage()
                if (cannotDraw != null || config == null) {
                    _state.update { it.copy(isLoaded = false, isLoading = false, error = cannotDraw, kind = kind) }
                    return@launch
                }
                if (kind == CharacterConfigKind.VRM) {
                    val refs = VrmAssetRefs.of(personaId, config)
                        ?: throw IllegalStateException("a VRM config that names an untrustworthy file")
                    assetResolver.refs = refs
                    // Over budget from an earlier model: drop the oldest before this one is fetched.
                    withContext(Dispatchers.IO) { assetResolver.evict() }
                    vrmFeed.send(BridgeMessages.config(config, personaName))
                    _state.update { it.copy(isLoaded = true, isLoading = false, error = null, kind = kind) }
                    return@launch
                }
                val poseTree = json.decodeFromJsonElement(PoseTree.serializer(), config.getValue("pose_tree"))
                compositor.loadPoseTree(poseTree, baseUrl)
                _state.update { it.copy(isLoaded = true, isLoading = false, error = null, kind = kind) }
            } catch (e: Exception) {
                android.util.Log.e("CharacterVM", "Failed to load character config: ${e.message}")
                _state.update { it.copy(isLoading = false, error = "Could not load the character.") }
            }
        }
    }

    /** The face a reopened conversation rests on: its last reply's last feeling (#244). */
    fun setRestingEmotion(emotion: String?) {
        if (emotion == null) return
        BridgeMessages.resting(emotion)?.let(vrmFeed::send)
    }

    /** The 3D page could not go on (no WebView, a dead renderer): say so in its place. */
    fun onCharacterProblem(message: String) {
        // The next time the sheet opens it loads again rather than keeping this.
        boundPersonaId = null
        _state.update { it.copy(isLoaded = false, error = message) }
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
