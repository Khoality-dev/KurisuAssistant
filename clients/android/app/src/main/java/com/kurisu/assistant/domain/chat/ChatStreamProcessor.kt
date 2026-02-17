package com.kurisu.assistant.domain.chat

import com.kurisu.assistant.data.model.*
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import javax.inject.Inject
import javax.inject.Singleton

data class StreamingState(
    val isStreaming: Boolean = false,
    val streamingMessages: List<Message> = emptyList(),
    val streamError: String? = null,
    val typingAgentName: String? = null,
)

@Singleton
class ChatStreamProcessor @Inject constructor(
    private val wsManager: WebSocketManager,
) {
    private val _state = MutableStateFlow(StreamingState())
    val state: StateFlow<StreamingState> = _state

    // TTS callbacks
    var onSentenceBoundary: ((text: String, voice: String?) -> Unit)? = null
    var onStreamDone: (() -> Unit)? = null
    var onConversationId: ((conversationId: Int) -> Unit)? = null

    private var currentRole: String? = null
    private var currentContent = StringBuilder()
    private var currentThinking = StringBuilder()
    private var currentName: String? = null
    private var currentVoice: String? = null
    private var ttsBuffer = StringBuilder()

    private var collectJob: Job? = null

    /** Start collecting WebSocket events in an internal scope. Idempotent. */
    fun startCollecting() {
        if (collectJob?.isActive == true) return
        collectJob = CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
            wsManager.events.collect { event ->
                when (event) {
                    is StreamChunkEvent -> handleChunk(event)
                    is DoneEvent -> handleDone(event)
                    is ErrorEvent -> handleError(event)
                    is AgentSwitchEvent -> { /* handled in UI */ }
                    else -> { /* media, vision, etc. handled elsewhere */ }
                }
            }
        }
    }

    /** Stop collecting WebSocket events. */
    fun stopCollecting() {
        collectJob?.cancel()
        collectJob = null
    }

    fun startStreaming() {
        resetStreamState()
        _state.update { it.copy(isStreaming = true) }
    }

    fun addUserMessage(text: String, images: List<String>? = null) {
        val userMsg = Message(
            role = "user",
            content = text,
            images = if (images.isNullOrEmpty()) null else images,
        )
        _state.update { it.copy(streamingMessages = it.streamingMessages + userMsg) }
    }

    fun cancelStream() {
        wsManager.sendCancel()
        flushTTSBuffer()
        _state.update { it.copy(isStreaming = false, typingAgentName = null) }
    }

    fun setError(error: String) {
        _state.update { it.copy(streamError = error, isStreaming = false) }
    }

    fun clearError() {
        _state.update { it.copy(streamError = null) }
    }

    fun clearStreamingMessages() {
        _state.update { it.copy(streamingMessages = emptyList()) }
    }

    private fun handleChunk(event: StreamChunkEvent) {
        // Notify conversation ID on first chunk
        onConversationId?.invoke(event.conversationId)

        val isNewBubble = event.role != currentRole || event.name != currentName

        if (isNewBubble) {
            // Flush TTS buffer when switching from assistant role
            if (currentRole == "assistant") {
                flushTTSBuffer()
            }

            currentRole = event.role
            currentContent = StringBuilder(event.content)
            currentThinking = StringBuilder(event.thinking ?: "")
            currentName = event.name
            currentVoice = event.voiceReference

            val newMsg = Message(
                role = event.role,
                content = event.content,
                thinking = event.thinking,
                name = event.name,
                voiceReference = event.voiceReference,
                agentId = event.agentId,
            )
            _state.update { it.copy(
                streamingMessages = it.streamingMessages + newMsg,
                typingAgentName = event.name,
            ) }
        } else {
            // Accumulate into existing bubble
            currentContent.append(event.content)
            if (event.thinking != null) currentThinking.append(event.thinking)
            if (event.voiceReference != null) currentVoice = event.voiceReference

            _state.update { s ->
                val msgs = s.streamingMessages.toMutableList()
                if (msgs.isNotEmpty()) {
                    val last = msgs.last()
                    msgs[msgs.lastIndex] = last.copy(
                        content = currentContent.toString(),
                        thinking = currentThinking.toString().ifEmpty { null },
                    )
                }
                s.copy(streamingMessages = msgs)
            }
        }

        // TTS sentence splitting (only for assistant, not tool messages)
        if (event.role == "assistant" && event.content.isNotEmpty()) {
            ttsBuffer.append(event.content)
            var result = splitAtSentenceBoundary(ttsBuffer.toString())
            while (result != null) {
                val (sentence, remainder) = result
                onSentenceBoundary?.invoke(sentence, currentVoice)
                ttsBuffer = StringBuilder(remainder)
                result = splitAtSentenceBoundary(ttsBuffer.toString())
            }
        }
    }

    private fun handleDone(event: DoneEvent) {
        flushTTSBuffer()
        _state.update { it.copy(isStreaming = false, typingAgentName = null) }
        onStreamDone?.invoke()
    }

    private fun handleError(event: ErrorEvent) {
        if (event.code == "CONNECTION_LOST") return // handled by reconnect
        _state.update { it.copy(
            streamError = event.error,
            isStreaming = false,
            typingAgentName = null,
        ) }
    }

    private fun flushTTSBuffer() {
        val remaining = ttsBuffer.toString().trim()
        if (remaining.isNotEmpty()) {
            onSentenceBoundary?.invoke(remaining, currentVoice)
        }
        ttsBuffer = StringBuilder()
    }

    private fun resetStreamState() {
        currentRole = null
        currentContent = StringBuilder()
        currentThinking = StringBuilder()
        currentName = null
        currentVoice = null
        ttsBuffer = StringBuilder()
        _state.update { StreamingState() }
    }
}
