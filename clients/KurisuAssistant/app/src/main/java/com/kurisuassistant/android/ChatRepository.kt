package com.kurisuassistant.android

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.kurisuassistant.android.model.ChatMessage
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * Singleton repository that manages chat messages and communicates with [Agent].
 */
object ChatRepository {
    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages
    private var currentIndex = 0
    private var pollJob: Job? = null

    private val player: AudioTrack by lazy {
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(32_000)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(1024)
            .build().apply { play() }
    }

    private val agent by lazy { Agent(player) }
    private val scope = CoroutineScope(Dispatchers.IO)

    val connected: LiveData<Boolean>
        get() = agent.connected
    val typing: LiveData<Boolean>
        get() = agent.typing
    val speaking: LiveData<Boolean>
        get() = agent.speaking

    fun init(context: Context? = null) {
        agent
        context?.let { ChatHistory.init(it) }
        if (context != null) {
            scope.launch {
                ChatHistory.fetchFromServer()
                if (ChatHistory.size > 0) {
                    _messages.postValue(ChatHistory.get(currentIndex))
                    startPolling(currentIndex)
                }
            }
        }
    }

    /**
     * Send a user text message to the LLM and stream the assistant reply.
     */
    fun sendMessage(text: String) {
        val list = _messages.value ?: mutableListOf()
        list.add(ChatMessage(text, "user", Instant.now().toString()))
        _messages.value = list
        ChatHistory.update(currentIndex, list)

        scope.launch {
            val channel: Channel<ChatMessage> = agent.chat(text)
            var assistant: ChatMessage? = null
            var idx = -1
            for (msg in channel) {
                when (msg.role) {
                    "assistant" -> {
                        if (assistant == null) {
                            assistant = ChatMessage("", "assistant", msg.createdAt)
                            list.add(assistant!!)
                            idx = list.lastIndex
                        }
                        assistant = assistant!!.copy(
                            text = assistant!!.text + msg.text,
                            toolCalls = msg.toolCalls ?: assistant!!.toolCalls,
                        )
                        list[idx] = assistant!!
                        if (msg.toolCalls != null) {
                            assistant = null
                            idx = -1
                        }
                    }
                    "tool" -> {
                        list.add(msg)
                        assistant = null
                        idx = -1
                    }
                }
                _messages.postValue(ArrayList(list))
                ChatHistory.update(currentIndex, list)
            }
        }
    }


    fun startNewConversation() {
        currentIndex = ChatHistory.add()
        _messages.postValue(mutableListOf())
        startPolling(currentIndex)
    }

    fun switchConversation(index: Int) {
        if (index == currentIndex || index < 0 || index >= ChatHistory.size) return
        ChatHistory.update(currentIndex, _messages.value ?: mutableListOf())
        currentIndex = index
        _messages.postValue(ArrayList(ChatHistory.get(index)))
        startPolling(currentIndex)
    }

    private fun startPolling(index: Int) {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (currentIndex == index) {
                ChatHistory.fetchConversation(index)?.let {
                    _messages.postValue(ArrayList(it))
                }
                delay(1000)
            }
        }
    }
}
