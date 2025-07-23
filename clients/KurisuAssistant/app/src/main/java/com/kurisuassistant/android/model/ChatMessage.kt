package com.kurisuassistant.android.model

/**
 * Represents a single chat message either from the user or the assistant.
 */

data class ChatMessage(
    val text: String,
    val role: String,
    val createdAt: String? = null,
    val isTemporary: Boolean = false,
    val messageId: Int? = null,
) {
    var conversationId: Int? = null
    val isUser: Boolean
        get() = role == "user"
}

