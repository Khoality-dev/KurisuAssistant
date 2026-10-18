package com.kurisu.assistant.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.repository.OnboardingRepository
import com.kurisu.assistant.domain.onboarding.ONBOARDING_PROVIDERS
import com.kurisu.assistant.domain.onboarding.OnboardingProvider
import com.kurisu.assistant.domain.onboarding.connectProvider
import com.kurisu.assistant.domain.onboarding.finishOnboarding
import com.kurisu.assistant.domain.onboarding.skipOnboarding
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
import javax.inject.Inject

data class OnboardingUiState(
    val providerId: String = "ollama",
    val providerValue: String = "",
    val connecting: Boolean = false,
    val models: List<ModelInfo> = emptyList(),
    val providerProblem: String? = null,
    val model: ModelInfo? = null,
    val finishing: Boolean = false,
    val error: String? = null,
    val confirmSkip: Boolean = false,
) {
    val provider: OnboardingProvider get() = ONBOARDING_PROVIDERS.first { it.id == providerId }
    val providerModels: List<ModelInfo> get() = models.filter { it.provider == providerId }
    val canFinish: Boolean get() = model != null && !finishing
}

sealed interface OnboardingEvent {
    data object Finished : OnboardingEvent
    data object Skipped : OnboardingEvent
}

/**
 * A new account's onboarding (#342): the model, and only the model (#376).
 * The rules — what connecting saves, what finishing writes — are
 * `domain/onboarding`, the desktop's own.
 */
@HiltViewModel
class OnboardingViewModel @Inject constructor(
    private val repo: OnboardingRepository,
    private val coreState: CoreState,
) : ViewModel() {

    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state

    private val _events = Channel<OnboardingEvent>(Channel.BUFFERED)
    val events: Flow<OnboardingEvent> = _events.receiveAsFlow()

    init {
        viewModelScope.launch {
            // A provider set up earlier (on another device, say) is already connected.
            val found = runCatching { repo.models().models }.getOrDefault(emptyList())
            if (found.isNotEmpty()) {
                _state.update { it.copy(models = found, providerId = found.first().provider, model = found.first()) }
            }
        }
    }

    /** Only a model of the provider shown is the one Start chatting saves. */
    fun setProvider(id: String) = _state.update { s ->
        s.copy(providerId = id, providerValue = "", providerProblem = null, model = s.models.firstOrNull { it.provider == id })
    }

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

    fun finish() {
        val model = _state.value.model ?: return
        _state.update { it.copy(finishing = true, error = null) }
        viewModelScope.launch {
            try {
                finishOnboarding(repo, model)
                // The first conversation is a new one, on the model just chosen.
                coreState.setConversationId(null)
                _events.send(OnboardingEvent.Finished)
            } catch (e: Exception) {
                _state.update { it.copy(finishing = false, error = apiErrorMessage(e, "The model was not saved.")) }
            }
        }
    }

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
