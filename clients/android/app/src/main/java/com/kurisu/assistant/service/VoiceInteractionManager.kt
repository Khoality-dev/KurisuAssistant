package com.kurisu.assistant.service

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class VoiceInteractionState(
    val isInteractionMode: Boolean = false,
)

@Singleton
class VoiceInteractionManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "VoiceInteraction"
        private const val IDLE_TIMEOUT_MS = 30000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var idleTimerJob: Job? = null

    private val _state = MutableStateFlow(VoiceInteractionState())
    val state: StateFlow<VoiceInteractionState> = _state

    private var triggerWord: String? = null
    private var pendingAutoSend: String? = null

    // Callback set by CoreService
    var onTranscriptSend: ((text: String) -> Unit)? = null
    var onEnterMode: (() -> Unit)? = null
    var onExitMode: (() -> Unit)? = null

    // External state (set by CoreService via streamProcessor observation)
    var isStreaming = false
    var isTTSActive = false

    fun setTriggerWord(word: String?) {
        triggerWord = word
    }

    /** Called by CoreService when an ASR transcript arrives. */
    fun handleTranscript(text: String) {
        val trigger = triggerWord ?: return

        if (_state.value.isInteractionMode) {
            // In interaction mode -- auto-send
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

    /** Called externally when streaming completes -- sends pending message if any */
    fun onStreamingComplete() {
        if (_state.value.isInteractionMode && pendingAutoSend != null) {
            val pending = pendingAutoSend
            pendingAutoSend = null
            if (pending != null) {
                onTranscriptSend?.invoke(pending)
            }
        }
    }

    /** Called externally when TTS + streaming both finish -- start idle timer */
    fun onTTSAndStreamingIdle() {
        if (_state.value.isInteractionMode && !isStreaming && !isTTSActive) {
            startIdleTimer()
        }
    }

    fun enterMode() {
        if (_state.value.isInteractionMode) return
        _state.update { it.copy(isInteractionMode = true) }
        playSound("start_effect")
        onEnterMode?.invoke()
    }

    fun exitMode() {
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
        idleTimerJob?.cancel()
        scope.cancel()
    }
}
