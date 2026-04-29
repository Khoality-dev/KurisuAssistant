package com.kurisu.assistant.ui.settings

import android.app.Application
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.AsrLanguageModelEntry
import com.kurisu.assistant.data.model.AsrModelInfo
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.audio.AudioRecorder
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.service.CoreState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TtsAsrUiState(
    val ttsBackend: String = "",
    val backends: List<String> = emptyList(),
    val autoPlay: Boolean = true,
    val emotionAlpha: Float = 0.5f,
    val useEmotionText: Boolean = false,
    val asrLanguage: String = "",
    val asrMode: String = "fixed",
    val asrFixedModel: String = "",
    val asrModels: List<AsrModelInfo> = emptyList(),
    val asrModelMap: List<AsrLanguageModelEntry> = emptyList(),
    val inputDevices: List<Pair<Int, String>> = emptyList(),
    val selectedDeviceType: Int = -1,
    val outputDevices: List<Pair<String, String>> = emptyList(),
    val selectedSpeakerId: String = "",
    val isTesting: Boolean = false,
    val micTestLevel: Float = 0f,
    val message: String? = null,
)

@HiltViewModel
class TtsAsrViewModel @Inject constructor(
    private val application: Application,
    private val ttsRepository: TtsRepository,
    private val prefs: PreferencesDataStore,
    private val audioRecorder: AudioRecorder,
    private val coreState: CoreState,
    private val api: KurisuApiService,
) : ViewModel() {

    companion object {
        private const val TAG = "TtsAsrViewModel"
    }

    private val _state = MutableStateFlow(TtsAsrUiState())
    val state: StateFlow<TtsAsrUiState> = _state

    init {
        viewModelScope.launch {
            val backend = prefs.getTTSBackend() ?: ""
            val autoPlay = prefs.getTTSAutoPlay()
            val alpha = prefs.getTTSEmotionAlpha() ?: 0.5f
            val useEmo = prefs.getTTSUseEmotionText() ?: false
            val lang = prefs.getAsrLanguage()
            val deviceType = prefs.getAudioInputDeviceType()
            audioRecorder.preferredDeviceType = deviceType
            val devices = audioRecorder.getInputDevices()
            val outputs = listOutputDevices()
            val asrMode = prefs.getAsrMode()
            val asrFixed = prefs.getAsrFixedModel()
            val asrMap = prefs.getAsrModelMap()
            val speaker = prefs.getSpeakerDeviceId()

            _state.update { it.copy(
                ttsBackend = backend,
                autoPlay = autoPlay,
                emotionAlpha = alpha,
                useEmotionText = useEmo,
                asrLanguage = lang,
                asrMode = asrMode,
                asrFixedModel = asrFixed,
                asrModelMap = asrMap,
                inputDevices = devices,
                selectedDeviceType = deviceType,
                outputDevices = outputs,
                selectedSpeakerId = speaker,
            ) }

            try {
                val backends = ttsRepository.listBackends()
                _state.update { it.copy(backends = backends) }
            } catch (_: Exception) {}

            try {
                val models = api.listAsrModels().data
                _state.update { it.copy(asrModels = models) }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load ASR models: ${e.message}")
            }
        }
    }

    private fun listOutputDevices(): List<Pair<String, String>> {
        val am = application.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { device ->
            val name = device.productName.toString().ifBlank { outputTypeName(device.type) }
            device.id.toString() to name
        }.distinctBy { it.first }
    }

    private fun outputTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Built-in Speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired Headphones"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB Device"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Headset"
        AudioDeviceInfo.TYPE_HDMI -> "HDMI"
        else -> "Output ($type)"
    }

    fun setTtsBackend(v: String) {
        _state.update { it.copy(ttsBackend = v) }
        viewModelScope.launch { prefs.setTTSBackend(v) }
    }

    fun setAutoPlay(v: Boolean) {
        _state.update { it.copy(autoPlay = v) }
        viewModelScope.launch { prefs.setTTSAutoPlay(v) }
    }

    fun setEmotionAlpha(v: Float) {
        _state.update { it.copy(emotionAlpha = v) }
        viewModelScope.launch { prefs.setTTSEmotionAlpha(v) }
    }

    fun setUseEmotionText(v: Boolean) {
        _state.update { it.copy(useEmotionText = v) }
        viewModelScope.launch { prefs.setTTSUseEmotionText(v) }
    }

    fun setAsrLanguage(v: String) {
        _state.update { it.copy(asrLanguage = v) }
        viewModelScope.launch { prefs.setAsrLanguage(v.trim()) }
    }

    fun setAsrMode(v: String) {
        _state.update { it.copy(asrMode = v) }
        viewModelScope.launch { prefs.setAsrMode(v) }
    }

    fun setAsrFixedModel(v: String) {
        _state.update { it.copy(asrFixedModel = v) }
        viewModelScope.launch { prefs.setAsrFixedModel(v) }
    }

    fun addAsrMapping() {
        val newMap = _state.value.asrModelMap + AsrLanguageModelEntry(language = "", model = "")
        _state.update { it.copy(asrModelMap = newMap) }
        viewModelScope.launch { prefs.setAsrModelMap(newMap) }
    }

    fun updateAsrMapping(index: Int, language: String? = null, model: String? = null) {
        val current = _state.value.asrModelMap.toMutableList()
        if (index !in current.indices) return
        val cur = current[index]
        current[index] = cur.copy(
            language = language?.trim() ?: cur.language,
            model = model ?: cur.model,
        )
        _state.update { it.copy(asrModelMap = current) }
        viewModelScope.launch { prefs.setAsrModelMap(current) }
    }

    fun deleteAsrMapping(index: Int) {
        val current = _state.value.asrModelMap.toMutableList()
        if (index !in current.indices) return
        current.removeAt(index)
        _state.update { it.copy(asrModelMap = current) }
        viewModelScope.launch { prefs.setAsrModelMap(current) }
    }

    fun selectMicDevice(type: Int) {
        viewModelScope.launch {
            prefs.setAudioInputDeviceType(type)
            audioRecorder.preferredDeviceType = type
            _state.update { it.copy(selectedDeviceType = type, message = "Microphone updated") }
        }
    }

    fun selectSpeakerDevice(id: String) {
        _state.update { it.copy(selectedSpeakerId = id) }
        viewModelScope.launch { prefs.setSpeakerDeviceId(id) }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    private var testJob: Job? = null
    private var wasServiceRunning = false

    fun testMicrophone() {
        if (_state.value.isTesting) { stopMicTest(); return }
        testJob = viewModelScope.launch {
            _state.update { it.copy(isTesting = true, micTestLevel = 0f) }
            try {
                wasServiceRunning = coreState.state.value.isServiceRunning
                if (wasServiceRunning) { CoreService.stop(application); delay(500) }
                audioRecorder.clearAccumulated()
                if (!audioRecorder.start()) {
                    _state.update { it.copy(isTesting = false, message = "Failed to start recording") }
                    if (wasServiceRunning) CoreService.start(application)
                    return@launch
                }
                audioRecorder.audioChunks.collect { chunk ->
                    var sum = 0.0
                    for (s in chunk) sum += s.toDouble() * s.toDouble()
                    val rms = kotlin.math.sqrt(sum / chunk.size)
                    _state.update { it.copy(micTestLevel = (rms / 6000.0).toFloat().coerceIn(0f, 1f)) }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _state.update { it.copy(message = "Test failed: ${e.message}") }
                stopMicTest()
            }
        }
    }

    private fun stopMicTest() {
        testJob?.cancel(); testJob = null
        audioRecorder.stop()
        _state.update { it.copy(isTesting = false, micTestLevel = 0f) }
        if (wasServiceRunning) { CoreService.start(application); wasServiceRunning = false }
    }
}
