package com.kurisuassistant.android

import androidx.lifecycle.LiveData
import androidx.lifecycle.ViewModel
import com.kurisuassistant.android.model.ChatMessage

/**
 * ViewModel exposing chat messages from [ChatRepository].
 */
class ChatViewModel : ViewModel() {
    val messages: LiveData<MutableList<ChatMessage>> = ChatRepository.messages

    fun sendMessage(text: String) {
        ChatRepository.sendMessage(text)
    }
}
