package com.kurisu.assistant.domain.voice

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import com.kurisu.assistant.data.repository.AsrRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class VoiceInteractionState(
    val isInteractionMode: Boolean = false,
    val isListening: Boolean = false,
    val isProcessing: Boolean = false,
)

@Singleton
class VoiceInteractionManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val audioRecorder: AudioRecorder,
    private val vad: VoiceActivityDetector,
    private val asrRepository: AsrRepository,
) {
    companion object {
        private const val TAG = "VoiceInteraction"
        private const val SILENCE_TIMEOUT_MS = 1500L
        private const val IDLE_TIMEOUT_MS = 30000L
        private const val SPEECH_THRESHOLD = 0.5f
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var vadJob: Job? = null
    private var idleTimerJob: Job? = null
    private var silenceTimerJob: Job? = null

    private val _state = MutableStateFlow(VoiceInteractionState())
    val state: StateFlow<VoiceInteractionState> = _state

    private var triggerWord: String? = null
    private var isSpeaking = false
    private var pendingAutoSend: String? = null

    // Callbacks set by ChatViewModel / service
    var onTranscriptSend: ((text: String) -> Unit)? = null
    var onEnterMode: (() -> Unit)? = null
    var onExitMode: (() -> Unit)? = null

    // Raw transcript callback (invoked before trigger word check) — used by HomeViewModel
    var onRawTranscript: ((text: String) -> Unit)? = null

    // External state (set by ChatViewModel)
    var isStreaming = false
    var isTTSActive = false

    fun setTriggerWord(word: String?) {
        triggerWord = word
    }

    fun startListening() {
        if (_state.value.isListening) return

        if (!vad.initialize()) {
            Log.e(TAG, "Failed to initialize VAD")
            return
        }

        val started = audioRecorder.start()
        if (!started) return

        _state.update { it.copy(isListening = true) }

        vadJob = scope.launch {
            audioRecorder.audioChunks.collect { chunk ->
                val probability = vad.processSamples(chunk)
                val isSpeechDetected = vad.isSpeech(probability)

                if (isSpeechDetected) {
                    isSpeaking = true
                    silenceTimerJob?.cancel()
                    silenceTimerJob = null
                } else if (isSpeaking && silenceTimerJob == null) {
                    // Speech ended — start silence timer
                    silenceTimerJob = launch {
                        delay(SILENCE_TIMEOUT_MS)
                        // Silence detected after speech → process recording
                        processCurrentRecording()
                    }
                }
            }
        }
    }

    fun stopListening() {
        vadJob?.cancel()
        silenceTimerJob?.cancel()
        idleTimerJob?.cancel()

        if (audioRecorder.isRecording) {
            // Transcribe any remaining speech
            if (isSpeaking) {
                scope.launch {
                    processCurrentRecording()
                }
            } else {
                audioRecorder.stop()
            }
        }

        isSpeaking = false
        _state.update { VoiceInteractionState() }

        if (_state.value.isInteractionMode) {
            exitMode()
        }
    }

    private suspend fun processCurrentRecording() {
        _state.update { it.copy(isProcessing = true) }
        isSpeaking = false

        try {
            val wavBytes = audioRecorder.stop()
            val text = asrRepository.transcribe(wavBytes)

            if (text.isNotBlank()) {
                handleTranscript(text.trim())
            }
        } catch (e: Exception) {
            Log.e(TAG, "ASR transcription error: ${e.message}")
        }

        _state.update { it.copy(isProcessing = false) }

        // Restart listening for continuous mode
        if (_state.value.isListening || _state.value.isInteractionMode) {
            audioRecorder.clearAccumulated()
            audioRecorder.start()
            vad.resetState()
        }
    }

    private fun handleTranscript(text: String) {
        onRawTranscript?.invoke(text)
        val trigger = triggerWord ?: return

        if (_state.value.isInteractionMode) {
            // In interaction mode — auto-send
            if (isStreaming) {
                pendingAutoSend = text
            } else {
                cancelIdleTimer()
                onTranscriptSend?.invoke(text)
            }
        } else {
            // Check for trigger word (case-insensitive)
            if (text.lowercase().contains(trigger.lowercase())) {
                enterMode()
                onTranscriptSend?.invoke(text)
            }
        }
    }

    /** Called externally when streaming completes — sends pending message if any */
    fun onStreamingComplete() {
        if (_state.value.isInteractionMode && pendingAutoSend != null) {
            val pending = pendingAutoSend
            pendingAutoSend = null
            if (pending != null) {
                onTranscriptSend?.invoke(pending)
            }
        }
    }

    /** Called externally when TTS + streaming both finish — start idle timer */
    fun onTTSAndStreamingIdle() {
        if (_state.value.isInteractionMode && !isStreaming && !isTTSActive) {
            startIdleTimer()
        }
    }

    private fun enterMode() {
        _state.update { it.copy(isInteractionMode = true) }
        playSound("start_effect")
        onEnterMode?.invoke()
    }

    private fun exitMode() {
        cancelIdleTimer()
        pendingAutoSend = null
        _state.update { it.copy(isInteractionMode = false) }
        playSound("stop_effect")
        onExitMode?.invoke()
    }

    private fun startIdleTimer() {
        cancelIdleTimer()
        idleTimerJob = scope.launch {
            delay(IDLE_TIMEOUT_MS)
            exitMode()
        }
    }

    private fun cancelIdleTimer() {
        idleTimerJob?.cancel()
        idleTimerJob = null
    }

    private fun playSound(name: String) {
        try {
            val resId = context.resources.getIdentifier(name, "raw", context.packageName)
            if (resId != 0) {
                MediaPlayer.create(context, resId)?.apply {
                    setOnCompletionListener { release() }
                    start()
                }
            }
        } catch (_: Exception) {
            // Sound effects are optional
        }
    }

    fun release() {
        stopListening()
        vad.release()
        audioRecorder.release()
        scope.cancel()
    }
}
