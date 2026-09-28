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

/**
 * Voice mode, the wake word and an interaction (#341) — the desktop's model
 * (#253), in the same words.
 */
data class VoiceInteractionState(
    /** Voice mode: chosen by the user, and the only time the mic listens. */
    val voiceMode: Boolean = false,
    /** An interaction: started by the wake word, it sends everything said. */
    val interactionActive: Boolean = false,
    /**
     * When the 30-second window ends the interaction ([System.currentTimeMillis]),
     * or null while it is shut: no interaction, a reply still streaming or being
     * spoken, or someone talking. The voice bar drains its top line towards it.
     */
    val idleDeadlineMs: Long? = null,
    /** When the wake word started this interaction. */
    val wokeAtMs: Long? = null,
    /** What was last said in this interaction, for the voice bar's second line. */
    val lastTranscript: String? = null,
)

@Singleton
class VoiceInteractionManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "VoiceInteraction"

        /** How long an interaction waits after the last reply before it ends. */
        const val IDLE_TIMEOUT_MS = 30000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var idleTimerJob: Job? = null

    private val _state = MutableStateFlow(VoiceInteractionState())
    val state: StateFlow<VoiceInteractionState> = _state

    private var triggerWord: String? = null
    private var pendingAutoSend: String? = null
    private var userTalking = false

    /** The clock the window is measured on; a test sets its own. */
    var clock: () -> Long = System::currentTimeMillis

    /**
     * Send what was said. `newConversation` is an interaction's first message:
     * each interaction is a new conversation.
     */
    var onTranscriptSend: ((text: String, newConversation: Boolean) -> Unit)? = null

    // External state (set by CoreService via streamProcessor observation)
    var isStreaming = false
    var isTTSActive = false

    fun setTriggerWord(word: String?) {
        triggerWord = word
    }

    /** Voice mode on or off. Off ends the interaction too. */
    fun setVoiceMode(on: Boolean) {
        if (!on) endInteraction()
        _state.update { it.copy(voiceMode = on) }
    }

    /**
     * What the mic heard. With voice mode off it is dropped (the mic is off; a
     * transcript still in flight is late). In an interaction it is sent. Waiting,
     * the wake word starts an interaction and is its first message, and anything
     * else is ignored — there is no dictation.
     */
    fun handleTranscript(text: String) {
        val s = _state.value
        if (!s.voiceMode) return

        if (s.interactionActive) {
            _state.update { it.copy(lastTranscript = text) }
            cancelIdleTimer()
            if (isStreaming) {
                pendingAutoSend = text
            } else {
                onTranscriptSend?.invoke(text, false)
            }
            return
        }

        val trigger = triggerWord
        if (!trigger.isNullOrBlank() && text.lowercase().contains(trigger.lowercase())) {
            startInteraction()
            _state.update { it.copy(lastTranscript = text) }
            onTranscriptSend?.invoke(text, true)
        }
    }

    /** Called externally when streaming completes -- sends pending message if any */
    fun onStreamingComplete() {
        if (_state.value.interactionActive && pendingAutoSend != null) {
            val pending = pendingAutoSend
            pendingAutoSend = null
            if (pending != null) {
                onTranscriptSend?.invoke(pending, false)
            }
        }
    }

    /** Called externally when TTS + streaming both finish: the window opens. */
    fun onTTSAndStreamingIdle() {
        if (_state.value.interactionActive && !isStreaming && !isTTSActive && !userTalking) {
            startIdleTimer()
        }
    }

    /**
     * Someone started or stopped talking — until what they said is transcribed.
     * Talking holds the window shut; it opens again, full, when it is over, so
     * saying anything refills it.
     */
    fun setUserTalking(talking: Boolean) {
        userTalking = talking
        if (talking) {
            cancelIdleTimer()
        } else {
            onTTSAndStreamingIdle()
        }
    }

    private fun startInteraction() {
        if (_state.value.interactionActive) return
        _state.update { it.copy(interactionActive = true, wokeAtMs = clock()) }
        playSound("start_effect")
    }

    /** The interaction ends; voice mode, if on, waits for the wake word again. */
    fun endInteraction() {
        cancelIdleTimer()
        pendingAutoSend = null
        val wasActive = _state.value.interactionActive
        _state.update { it.copy(interactionActive = false, idleDeadlineMs = null, wokeAtMs = null, lastTranscript = null) }
        if (wasActive) playSound("stop_effect")
    }

    private fun startIdleTimer() {
        cancelIdleTimer()
        _state.update { it.copy(idleDeadlineMs = clock() + IDLE_TIMEOUT_MS) }
        idleTimerJob = scope.launch {
            delay(IDLE_TIMEOUT_MS)
            endInteraction()
        }
    }

    private fun cancelIdleTimer() {
        idleTimerJob?.cancel()
        idleTimerJob = null
        if (_state.value.idleDeadlineMs != null) {
            _state.update { it.copy(idleDeadlineMs = null) }
        }
    }

    private fun playSound(name: String) {
        try {
            val resId = context.resources.getIdentifier(name, "raw", context.packageName)
            if (resId != 0) {
                MediaPlayer.create(context, resId)?.apply {
                    setOnCompletionListener { release() }
                    setOnErrorListener { mp, _, _ -> mp.release(); true }
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
