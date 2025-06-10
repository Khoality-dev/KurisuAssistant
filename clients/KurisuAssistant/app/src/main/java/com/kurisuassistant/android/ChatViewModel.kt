package com.kurisuassistant.android

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisuassistant.android.model.ChatMessage
import kotlinx.coroutines.launch

/**
 * ViewModel holding the chat conversation state.
 */
class ChatViewModel : ViewModel() {

    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages

    private val agent: Agent

    init {
        val player = AudioTrack.Builder()
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
            .build()
        player.play()
        agent = Agent(player)
    }

    /**
     * Send a user message to the LLM via [Agent] and update the UI state.
     */
    fun sendMessage(text: String) {
        val list = _messages.value ?: mutableListOf()
        list.add(ChatMessage(text, true))
        _messages.value = list

        viewModelScope.launch {
            val channel = agent.chat(text)
            val assistant = ChatMessage("", false)
            list.add(assistant)
            var idx = list.lastIndex
            _messages.postValue(ArrayList(list))
            for (chunk in channel) {
                list[idx] = ChatMessage(list[idx].text + chunk, false)
                _messages.postValue(ArrayList(list))
            }
        }
    }
}

