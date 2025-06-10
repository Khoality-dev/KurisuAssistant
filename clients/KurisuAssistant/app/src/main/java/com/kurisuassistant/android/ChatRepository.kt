package com.kurisuassistant.android

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.kurisuassistant.android.model.ChatMessage
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Singleton repository that manages chat messages and communicates with [Agent].
 */
object ChatRepository {
    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages

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

    /**
     * Send a user text message to the LLM and stream the assistant reply.
     */
    fun sendMessage(text: String) {
        val list = _messages.value ?: mutableListOf()
        list.add(ChatMessage(text, true))
        _messages.value = list

        scope.launch {
            val channel: Channel<String> = agent.chat(text)
            val assistant = ChatMessage("", false)
            list.add(assistant)
            val idx = list.lastIndex
            _messages.postValue(ArrayList(list))
            for (chunk in channel) {
                list[idx] = ChatMessage(list[idx].text + chunk, false)
                _messages.postValue(ArrayList(list))
            }
        }
    }

    /**
     * Add a user message originating from voice input. Returns the index of the
     * assistant message that should be updated with chunks.
     */
    fun addVoiceUserMessage(text: String): Int {
        val list = _messages.value ?: mutableListOf()
        list.add(ChatMessage(text, true))
        val assistant = ChatMessage("", false)
        list.add(assistant)
        val idx = list.lastIndex
        _messages.postValue(ArrayList(list))
        return idx
    }

    /**
     * Append a chunk of assistant text to a message at [index]. Used when the
     * service streams replies via its own [Agent].
     */
    fun appendAssistantChunk(chunk: String, index: Int) {
        val list = _messages.value ?: return
        if (index >= list.size) return
        val current = list[index]
        list[index] = ChatMessage(current.text + chunk, false)
        _messages.postValue(ArrayList(list))
    }
}
