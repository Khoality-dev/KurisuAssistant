package com.kurisuassistant.android

import androidx.lifecycle.LiveData
import androidx.lifecycle.ViewModel
import com.kurisuassistant.android.model.ChatMessage
import android.net.Uri

/**
 * ViewModel exposing chat messages from [ChatRepository].
 */
class ChatViewModel : ViewModel() {
    val messages: LiveData<MutableList<ChatMessage>> = ChatRepository.messages
    val connected: LiveData<Boolean> = ChatRepository.connected
    val typing: LiveData<Boolean> = ChatRepository.typing
    val speaking: LiveData<Boolean> = ChatRepository.speaking



    fun sendMessage(text: String, imageUris: List<Uri> = emptyList()): Boolean {
        return ChatRepository.sendMessage(text, imageUris)
    }
    
    fun refreshConversationList(onComplete: () -> Unit) {
        ChatRepository.refreshConversationList(onComplete)
    }
}
