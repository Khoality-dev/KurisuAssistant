package com.kurisu.assistant.service

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class CoreServiceState(
    val isServiceRunning: Boolean = false,
    val isRecording: Boolean = false,
    val isProcessingAsr: Boolean = false,
    val lastTranscript: String? = null,
    val conversationId: Int? = null,
    val selectedAgentId: Int? = null,
)

@Singleton
class CoreState @Inject constructor() {
    private val _state = MutableStateFlow(CoreServiceState())
    val state: StateFlow<CoreServiceState> = _state

    private val _asrTranscripts = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val asrTranscripts: SharedFlow<String> = _asrTranscripts

    private val _streamDone = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val streamDone: SharedFlow<Unit> = _streamDone

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

    fun setSelectedAgentId(id: Int?) {
        _state.update { it.copy(selectedAgentId = id) }
    }

    fun emitStreamDone() {
        _streamDone.tryEmit(Unit)
    }
}
