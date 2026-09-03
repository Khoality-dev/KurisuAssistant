package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.repository.AgentRepository
import com.kurisu.assistant.data.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class AccountUiState(
    val ollamaUrl: String = "",
    val geminiApiKey: String = "",
    val nvidiaApiKey: String = "",
    val summaryModel: String = "",
    val contextSize: String = "8192",
    val availableModels: List<ModelInfo> = emptyList(),
    val isRefreshingModels: Boolean = false,
    val isSaving: Boolean = false,
    val message: String? = null,
    val serverUrl: String = "",
    val isValidatingGemini: Boolean = false,
    val isValidatingNvidia: Boolean = false,
)

@HiltViewModel
class AccountViewModel @Inject constructor(
    private val api: KurisuApiService,
    private val authRepository: AuthRepository,
    private val agentRepository: AgentRepository,
    private val prefs: PreferencesDataStore,
    private val dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor,
) : ViewModel() {

    private val _state = MutableStateFlow(AccountUiState())
    val state: StateFlow<AccountUiState> = _state

    init {
        viewModelScope.launch {
            val url = prefs.getBackendUrl()
            _state.update { it.copy(serverUrl = url) }
            try {
                val user = authRepository.loadUserProfile()
                _state.update { it.copy(
                    ollamaUrl = user.ollamaUrl ?: "",
                    geminiApiKey = user.geminiApiKey ?: "",
                    nvidiaApiKey = user.nvidiaApiKey ?: "",
                    summaryModel = user.summaryModel ?: "",
                    contextSize = (user.contextSize ?: 8192).toString(),
                ) }
            } catch (_: Exception) {}
            refreshModels()
        }
    }

    fun refreshModels() {
        viewModelScope.launch {
            _state.update { it.copy(isRefreshingModels = true) }
            try {
                val models = agentRepository.listModels()
                _state.update { it.copy(availableModels = models) }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed to load models: ${e.message}") }
            } finally {
                _state.update { it.copy(isRefreshingModels = false) }
            }
        }
    }

    fun setServerUrl(v: String) = _state.update { it.copy(serverUrl = v) }
    fun setOllamaUrl(v: String) = _state.update { it.copy(ollamaUrl = v) }
    fun setGeminiApiKey(v: String) = _state.update { it.copy(geminiApiKey = v) }
    fun setNvidiaApiKey(v: String) = _state.update { it.copy(nvidiaApiKey = v) }
    fun setSummaryModel(v: String) = _state.update { it.copy(summaryModel = v) }
    fun setContextSize(v: String) = _state.update { it.copy(contextSize = v) }
    fun clearMessage() = _state.update { it.copy(message = null) }

    fun saveServerUrl() {
        viewModelScope.launch {
            val url = _state.value.serverUrl.trim().trimEnd('/')
            prefs.setBackendUrl(url)
            dynamicBaseUrlInterceptor.setCachedBaseUrl(url)
            _state.update { it.copy(message = "Server URL saved") }
        }
    }

    fun saveProfile() {
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true) }
            try {
                val current = authRepository.loadUserProfile()
                val ctxSize = _state.value.contextSize.toIntOrNull()
                authRepository.updateUserProfile(current.copy(
                    ollamaUrl = _state.value.ollamaUrl.trim().ifBlank { null },
                    geminiApiKey = _state.value.geminiApiKey.trim().ifBlank { null },
                    nvidiaApiKey = _state.value.nvidiaApiKey.trim().ifBlank { null },
                    summaryModel = _state.value.summaryModel.trim().ifBlank { null },
                    contextSize = ctxSize,
                ))
                _state.update { it.copy(message = "Settings saved") }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun validateGeminiKey() {
        val key = _state.value.geminiApiKey.trim()
        if (key.isBlank()) { _state.update { it.copy(message = "Enter a key first") }; return }
        viewModelScope.launch {
            _state.update { it.copy(isValidatingGemini = true) }
            try {
                val result = api.validateApiKey(mapOf("provider" to "gemini", "api_key" to key))
                val valid = result["valid"] as? Boolean ?: false
                val modelCount = (result["model_count"] as? Number)?.toInt()
                val error = result["error"] as? String
                _state.update { it.copy(message = if (valid) "Valid ($modelCount models)" else "Invalid: ${error ?: "unknown"}") }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Validation failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isValidatingGemini = false) }
            }
        }
    }

    fun validateNvidiaKey() {
        val key = _state.value.nvidiaApiKey.trim()
        if (key.isBlank()) { _state.update { it.copy(message = "Enter a key first") }; return }
        viewModelScope.launch {
            _state.update { it.copy(isValidatingNvidia = true) }
            try {
                val result = api.validateApiKey(mapOf("provider" to "nvidia", "api_key" to key))
                val valid = result["valid"] as? Boolean ?: false
                val modelCount = (result["model_count"] as? Number)?.toInt()
                val error = result["error"] as? String
                _state.update { it.copy(message = if (valid) "Valid ($modelCount models)" else "Invalid: ${error ?: "unknown"}") }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Validation failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isValidatingNvidia = false) }
            }
        }
    }
}
