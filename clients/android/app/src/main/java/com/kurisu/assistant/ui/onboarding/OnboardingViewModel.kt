package com.kurisu.assistant.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.DriveFiles
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.VoiceInfo
import com.kurisu.assistant.data.repository.OnboardingRepository
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.drive.UploadSource
import com.kurisu.assistant.domain.onboarding.FinishPart
import com.kurisu.assistant.domain.onboarding.OnboardingChoices
import com.kurisu.assistant.domain.onboarding.OnboardingRun
import com.kurisu.assistant.domain.onboarding.OnboardingStep
import com.kurisu.assistant.domain.onboarding.PersonaChoice
import com.kurisu.assistant.domain.onboarding.connectProvider
import com.kurisu.assistant.domain.onboarding.defaultWakeWord
import com.kurisu.assistant.domain.onboarding.onboardingSteps
import com.kurisu.assistant.domain.onboarding.skipOnboarding
import com.kurisu.assistant.domain.tts.TtsQueueManager
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.ui.assistant.apiErrorMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

data class OnboardingUiState(
    val withPersona: Boolean = true,
    val stepIndex: Int = 0,
    // Model
    val providerId: String = "ollama",
    val providerValue: String = "",
    val connecting: Boolean = false,
    val models: List<ModelInfo> = emptyList(),
    val providerProblem: String? = null,
    val model: ModelInfo? = null,
    // Persona
    val name: String = "",
    val preferredName: String = "",
    val avatarUuid: String? = null,
    val avatarUrl: String? = null,
    val uploadingAvatar: Boolean = false,
    // Voice and character
    val voices: List<VoiceInfo> = emptyList(),
    val voice: String? = null,
    val wantsModel: Boolean = true,
    val vrmName: String? = null,
    val vrmSize: Long? = null,
    // Wake word
    val wakeWord: String = "",
    val wakeTouched: Boolean = false,
    // Finishing
    val finishing: Boolean = false,
    val part: FinishPart? = null,
    val uploadFraction: Float? = null,
    val error: String? = null,
    val confirmSkip: Boolean = false,
) {
    val steps: List<OnboardingStep> get() = onboardingSteps(withPersona)
    val step: OnboardingStep get() = steps[stepIndex.coerceAtMost(steps.lastIndex)]
    val isLast: Boolean get() = stepIndex >= steps.lastIndex
    val providerModels: List<ModelInfo> get() = models.filter { it.provider == providerId }
    val canGoOn: Boolean
        get() = when (step) {
            OnboardingStep.PERSONA -> !withPersona || name.isNotBlank()
            OnboardingStep.CHARACTER -> !wantsModel || vrmName != null
            else -> true
        }
}

sealed interface OnboardingEvent {
    data object Finished : OnboardingEvent
    data object Skipped : OnboardingEvent
}

/**
 * A new account's onboarding (#342): the model, an optional first persona with
 * its voice and character, and the wake word. The rules — which steps apply,
 * what finishing writes and in what order, a retry that goes on from where it
 * stopped — are `domain/onboarding`, the desktop's own.
 */
@HiltViewModel
class OnboardingViewModel @Inject constructor(
    private val repo: OnboardingRepository,
    private val ttsRepository: TtsRepository,
    private val ttsQueue: TtsQueueManager,
    private val files: DriveFiles,
    private val coreState: CoreState,
) : ViewModel() {

    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state

    private val _events = Channel<OnboardingEvent>(Channel.BUFFERED)
    val events: Flow<OnboardingEvent> = _events.receiveAsFlow()

    private val run = OnboardingRun(repo)
    private var vrm: UploadSource? = null

    init {
        viewModelScope.launch {
            // A provider set up earlier (on another device, say) is already connected.
            val found = runCatching { repo.models().models }.getOrDefault(emptyList())
            if (found.isNotEmpty()) {
                _state.update { it.copy(models = found, providerId = found.first().provider, model = found.first()) }
            }
        }
        viewModelScope.launch {
            val voices = runCatching { ttsRepository.listVoices(null) }.getOrDefault(emptyList())
            _state.update { it.copy(voices = voices) }
        }
    }

    // ── Model ──

    fun setProvider(id: String) = _state.update { it.copy(providerId = id, providerValue = "", providerProblem = null) }

    fun setProviderValue(value: String) = _state.update { it.copy(providerValue = value) }

    fun connect() {
        val s = _state.value
        _state.update { it.copy(connecting = true, providerProblem = null) }
        viewModelScope.launch {
            try {
                val result = connectProvider(repo, s.providerId, s.providerValue)
                _state.update { state ->
                    state.copy(
                        models = state.models.filter { it.provider != s.providerId } + result.models,
                        providerProblem = result.problem,
                        model = result.models.firstOrNull() ?: state.model,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(providerProblem = apiErrorMessage(e, "Could not connect to that provider.")) }
            } finally {
                _state.update { it.copy(connecting = false) }
            }
        }
    }

    fun pickModel(model: ModelInfo) = _state.update { it.copy(model = model) }

    // ── Persona ──

    fun setWithPersona(with: Boolean) = _state.update { it.copy(withPersona = with) }

    fun setName(name: String) = _state.update { it.copy(name = name) }

    fun setPreferredName(name: String) = _state.update { it.copy(preferredName = name) }

    fun uploadAvatar(file: File) {
        _state.update { it.copy(uploadingAvatar = true) }
        viewModelScope.launch {
            try {
                val uuid = repo.uploadAvatar(file)
                val url = repo.imageUrl(uuid)
                _state.update { it.copy(avatarUuid = uuid, avatarUrl = url) }
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not upload the picture.")) }
            } finally {
                _state.update { it.copy(uploadingAvatar = false) }
            }
        }
    }

    // ── Voice and character ──

    fun pickVoice(id: String?) = _state.update { it.copy(voice = id) }

    /** Say the persona's line in [id], through the same queue the chat speaks with. */
    fun previewVoice(id: String) {
        val name = _state.value.name.trim().ifEmpty { "your assistant" }
        ttsQueue.clearQueue()
        ttsQueue.queueText("Hello. This is $name.", id)
    }

    fun setWantsModel(wants: Boolean) = _state.update { it.copy(wantsModel = wants) }

    fun pickVrm(uri: String) {
        val source = files.source(uri)
        vrm = source
        _state.update { it.copy(vrmName = source.name, vrmSize = source.size) }
    }

    // ── Wake word ──

    fun setWakeWord(word: String) = _state.update { it.copy(wakeWord = word, wakeTouched = true) }

    // ── Moving ──

    fun next() {
        _state.update { s ->
            if (!s.canGoOn || s.isLast) return@update s
            val moved = s.copy(stepIndex = s.stepIndex + 1, error = null)
            if (moved.step == OnboardingStep.WAKE_WORD && !moved.wakeTouched) {
                moved.copy(wakeWord = defaultWakeWord(if (moved.withPersona) moved.name else null))
            } else moved
        }
    }

    fun back() = _state.update { it.copy(stepIndex = (it.stepIndex - 1).coerceAtLeast(0), error = null) }

    fun finish() {
        val s = _state.value
        _state.update { it.copy(finishing = true, error = null) }
        viewModelScope.launch {
            try {
                run.finish(
                    OnboardingChoices(
                        model = s.model,
                        persona = if (s.withPersona) {
                            PersonaChoice(s.name, s.preferredName, s.avatarUuid, s.voice, if (s.wantsModel) vrm else null)
                        } else null,
                        wakeWord = s.wakeWord,
                    ),
                    onPart = { part -> _state.update { it.copy(part = part) } },
                    onUploadProgress = { sent, total ->
                        _state.update { it.copy(uploadFraction = total?.takeIf { t -> t > 0 }?.let { t -> sent.toFloat() / t }) }
                    },
                )
                // The first conversation is a new one, on what was just chosen.
                coreState.setConversationId(null)
                _events.send(OnboardingEvent.Finished)
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Setting up did not finish.")) }
            }
        }
    }

    /** Back from a failed finish to the steps, to change something. */
    fun leaveFinishing() = _state.update { it.copy(finishing = false, error = null, part = null) }

    fun askSkip() = _state.update { it.copy(confirmSkip = true) }

    fun dismissSkip() = _state.update { it.copy(confirmSkip = false) }

    fun skip() {
        _state.update { it.copy(confirmSkip = false) }
        viewModelScope.launch {
            runCatching { skipOnboarding(repo) }
            _events.send(OnboardingEvent.Skipped)
        }
    }
}
