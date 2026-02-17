package com.kurisu.assistant.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.TtsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val serverUrl: String = "",
    val username: String = "",
    val preferredName: String = "",
    val ttsBackend: String = "",
    val ttsVoice: String = "",
    val backends: List<String> = emptyList(),
    val voices: List<String> = emptyList(),
    val isSaving: Boolean = false,
    val message: String? = null,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val ttsRepository: TtsRepository,
    private val prefs: PreferencesDataStore,
    private val dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state

    init {
        viewModelScope.launch {
            val url = prefs.getBackendUrl()
            val ttsBackend = prefs.getTTSBackend() ?: ""
            val ttsVoice = prefs.getTTSVoice() ?: ""

            _state.update { it.copy(
                serverUrl = url,
                ttsBackend = ttsBackend,
                ttsVoice = ttsVoice,
            ) }

            try {
                val user = authRepository.loadUserProfile()
                _state.update { it.copy(
                    username = user.username,
                    preferredName = user.preferredName ?: "",
                ) }
            } catch (_: Exception) {}

            loadTtsOptions()
        }
    }

    fun setServerUrl(v: String) = _state.update { it.copy(serverUrl = v) }
    fun setPreferredName(v: String) = _state.update { it.copy(preferredName = v) }
    fun setTtsBackend(v: String) = _state.update { it.copy(ttsBackend = v) }
    fun setTtsVoice(v: String) = _state.update { it.copy(ttsVoice = v) }
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
                authRepository.updateUserProfile(
                    current.copy(preferredName = _state.value.preferredName)
                )
                _state.update { it.copy(message = "Profile updated") }
            } catch (e: Exception) {
                _state.update { it.copy(message = "Failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    fun saveTtsSettings() {
        viewModelScope.launch {
            prefs.setTTSBackend(_state.value.ttsBackend)
            prefs.setTTSVoice(_state.value.ttsVoice)
            _state.update { it.copy(message = "TTS settings saved") }
        }
    }

    fun logout(onLogout: () -> Unit) {
        viewModelScope.launch {
            authRepository.logout()
            onLogout()
        }
    }

    private fun loadTtsOptions() {
        viewModelScope.launch {
            try {
                val backends = ttsRepository.listBackends()
                _state.update { it.copy(backends = backends) }
            } catch (_: Exception) {}

            try {
                val voices = ttsRepository.listVoices(_state.value.ttsBackend.ifBlank { null })
                _state.update { it.copy(voices = voices) }
            } catch (_: Exception) {}
        }
    }
}
