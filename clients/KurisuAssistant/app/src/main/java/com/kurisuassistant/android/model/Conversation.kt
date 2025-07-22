package com.kurisuassistant.android

import com.kurisuassistant.android.model.ChatMessage

data class Conversation(
    val title: String,
    val id: Int?,
    var maxOffset: Int = 0,
    var nextFetchOffset: Int = 0,
    private val _messages: ArrayDeque<ChatMessage> = ArrayDeque()
) {
    companion object {
        fun createNew(title: String = ""): Conversation {
            return Conversation(title, null)
        }
    }
    val messages: List<ChatMessage>
        get() = _messages.toList()
    
    val messageCount: Int
        get() = _messages.size
    
    fun addMessage(message: ChatMessage) {
        _messages.addLast(message)
    }
    
    fun addMessagesAtEnd(messages: List<ChatMessage>) {
        messages.forEach { _messages.addLast(it) }
    }
    
    fun addMessagesAtBeginning(messages: List<ChatMessage>) {
        messages.reversed().forEach { _messages.addFirst(it) }
    }
    
    fun clearMessages() {
        _messages.clear()
    }
    
    fun replaceMessages(messages: List<ChatMessage>) {
        _messages.clear()
        messages.forEach { _messages.addLast(it) }
    }
}