package com.kurisu.assistant.ui.settings

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.api.DynamicBaseUrlInterceptor
import com.kurisu.assistant.data.repository.AuthRepository
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.data.repository.UpdateRepository
import com.kurisu.assistant.domain.audio.AudioRecorder
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.service.CoreState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import android.app.Application
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
    val ollamaUrl: String = "",
    val ttsBackend: String = "",
    val ttsVoice: String = "",
    val backends: List<String> = emptyList(),
    val voices: List<String> = emptyList(),
    val isSaving: Boolean = false,
    val message: String? = null,
    val isCheckingUpdate: Boolean = false,
    val updateRelease: GithubRelease? = null,
    val updateProgress: Float? = null,
    val updateApkFile: java.io.File? = null,
    val inputDevices: List<Pair<Int, String>> = emptyList(),
    val selectedDeviceType: Int = -1,
    val isTesting: Boolean = false,
    val micTestLevel: Float = 0f,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val application: Application,
    private val authRepository: AuthRepository,
    private val ttsRepository: TtsRepository,
    private val prefs: PreferencesDataStore,
    private val dynamicBaseUrlInterceptor: DynamicBaseUrlInterceptor,
    private val updateRepository: UpdateRepository,
    private val audioRecorder: AudioRecorder,
    private val coreState: CoreState,
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
                    ollamaUrl = user.ollamaUrl ?: "",
                ) }
            } catch (_: Exception) {}

            loadTtsOptions()
            loadMicOptions()
        }
    }

    fun setServerUrl(v: String) = _state.update { it.copy(serverUrl = v) }
    fun setPreferredName(v: String) = _state.update { it.copy(preferredName = v) }
    fun setOllamaUrl(v: String) = _state.update { it.copy(ollamaUrl = v) }
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
                    current.copy(
                        preferredName = _state.value.preferredName,
                        ollamaUrl = _state.value.ollamaUrl.trim().trimEnd('/').ifBlank { null },
                    )
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

    fun checkForUpdate() {
        viewModelScope.launch {
            _state.update { it.copy(isCheckingUpdate = true) }
            try {
                val release = updateRepository.checkForUpdate()
                if (release != null) {
                    _state.update { it.copy(updateRelease = release) }
                } else {
                    _state.update { it.copy(message = "You're on the latest version") }
                }
            } catch (e: Exception) {
                Log.e("SettingsVM", "Update check failed", e)
                _state.update { it.copy(message = "Update check failed: ${e.message}") }
            } finally {
                _state.update { it.copy(isCheckingUpdate = false) }
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
                Log.e("SettingsVM", "Download failed", e)
                _state.update { it.copy(updateProgress = null, message = "Download failed: ${e.message}") }
            }
        }
    }

    fun dismissUpdate() {
        _state.update { it.copy(updateRelease = null, updateProgress = null, updateApkFile = null) }
    }

    fun selectMicDevice(type: Int) {
        viewModelScope.launch {
            prefs.setAudioInputDeviceType(type)
            audioRecorder.preferredDeviceType = type
            _state.update { it.copy(
                selectedDeviceType = type,
                message = "Microphone updated (takes effect on next recording)",
            ) }
        }
    }

    private var testJob: Job? = null
    private var wasServiceRunning = false

    fun testMicrophone() {
        if (_state.value.isTesting) {
            stopMicTest()
            return
        }
        startMicTest()
    }

    private fun startMicTest() {
        testJob = viewModelScope.launch {
            _state.update { it.copy(isTesting = true, micTestLevel = 0f) }
            try {
                wasServiceRunning = coreState.state.value.isServiceRunning
                if (wasServiceRunning) {
                    CoreService.stop(application)
                    delay(500)
                }

                audioRecorder.clearAccumulated()
                val started = audioRecorder.start()
                if (!started) {
                    _state.update { it.copy(isTesting = false, message = "Failed to start recording") }
                    if (wasServiceRunning) CoreService.start(application)
                    return@launch
                }

                // Collect chunks and show live amplitude
                audioRecorder.audioChunks.collect { chunk ->
                    var sum = 0.0
                    for (s in chunk) { sum += s.toDouble() * s.toDouble() }
                    val rms = kotlin.math.sqrt(sum / chunk.size)
                    val level = (rms / 6000.0).toFloat().coerceIn(0f, 1f)
                    _state.update { it.copy(micTestLevel = level) }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Log.e("SettingsVM", "Mic test failed", e)
                _state.update { it.copy(message = "Test failed: ${e.message}") }
                stopMicTest()
            }
        }
    }

    private fun stopMicTest() {
        testJob?.cancel()
        testJob = null
        audioRecorder.stop()
        _state.update { it.copy(isTesting = false, micTestLevel = 0f) }
        if (wasServiceRunning) {
            CoreService.start(application)
            wasServiceRunning = false
        }
    }

    fun logout(onLogout: () -> Unit) {
        viewModelScope.launch {
            authRepository.logout()
            onLogout()
        }
    }

    private fun loadMicOptions() {
        viewModelScope.launch {
            val savedType = prefs.getAudioInputDeviceType()
            audioRecorder.preferredDeviceType = savedType
            val devices = audioRecorder.getInputDevices()
            _state.update { it.copy(
                inputDevices = devices,
                selectedDeviceType = savedType,
            ) }
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
