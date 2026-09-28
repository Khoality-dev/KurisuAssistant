package com.kurisu.assistant.service

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import com.kurisu.assistant.domain.voice.MicProblem
import javax.inject.Inject
import javax.inject.Singleton

data class CoreServiceState(
    val isServiceRunning: Boolean = false,
    val isRecording: Boolean = false,
    val isProcessingAsr: Boolean = false,
    /** Why the mic could not start in voice mode, until it does (#341). */
    val micProblem: MicProblem? = null,
    /** Someone is talking right now: from the VAD's start of speech to its end. */
    val userTalking: Boolean = false,
    val lastTranscript: String? = null,
    val conversationId: Int? = null,
    // The persona answering in [conversationId]; null is the assistant answering
    // as itself (#302). There is nothing to "select": one assistant owns
    // capability, and this only records who is speaking.
    val currentPersonaId: Int? = null,
)

@Singleton
class CoreState @Inject constructor() {
    private val _state = MutableStateFlow(CoreServiceState())
    val state: StateFlow<CoreServiceState> = _state

    private val _asrTranscripts = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val asrTranscripts: SharedFlow<String> = _asrTranscripts

    private val _streamDone = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val streamDone: SharedFlow<Unit> = _streamDone

    // The wake word started an interaction, and each interaction is a new
    // conversation (#341): the instant it was heard, for the chat to clear to a
    // new conversation and mark it.
    private val _newInteractions = MutableSharedFlow<Long>(extraBufferCapacity = 1)
    val newInteractions: SharedFlow<Long> = _newInteractions

    // A speech request (transcription or synthesis) that failed, as one sentence
    // for whoever is looking at the chat. Speech failures used to be logged and
    // otherwise silent (#200).
    private val _speechErrors = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val speechErrors: SharedFlow<String> = _speechErrors

    fun setServiceRunning(running: Boolean) {
        _state.update { it.copy(isServiceRunning = running) }
    }

    fun setRecording(recording: Boolean) {
        _state.update { it.copy(isRecording = recording) }
    }

    fun setProcessingAsr(processing: Boolean) {
        _state.update { it.copy(isProcessingAsr = processing) }
    }

    fun emitTranscript(text: String) {
        _state.update { it.copy(lastTranscript = text) }
        _asrTranscripts.tryEmit(text)
    }

    fun setConversationId(id: Int?) {
        _state.update { it.copy(conversationId = id) }
    }

    fun setCurrentPersonaId(id: Int?) {
        _state.update { it.copy(currentPersonaId = id) }
    }

    fun emitStreamDone() {
        _streamDone.tryEmit(Unit)
    }

    fun setMicProblem(problem: MicProblem?) {
        _state.update { it.copy(micProblem = problem) }
    }

    fun setUserTalking(talking: Boolean) {
        _state.update { it.copy(userTalking = talking) }
    }

    /** A new interaction: the chat leaves its conversation for a new one. */
    fun startNewInteraction(atMs: Long) {
        _state.update { it.copy(conversationId = null) }
        _newInteractions.tryEmit(atMs)
    }

    fun emitSpeechError(message: String) {
        _speechErrors.tryEmit(message)
    }
}
