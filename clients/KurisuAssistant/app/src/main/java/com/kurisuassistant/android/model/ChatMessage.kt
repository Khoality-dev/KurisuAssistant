package com.kurisuassistant.android.model

/**
 * Represents a single chat message either from the user or the assistant.
 */
import org.json.JSONArray
import org.json.JSONObject

data class ChatMessage(
    val text: String,
    val role: String,
    val createdAt: String? = null,
    val toolCalls: String? = null,
    val isTemporary: Boolean = false,
    val messageHash: String? = null,
) {
    var conversationId: Int? = null
    val isUser: Boolean
        get() = role == "user"

    val displayText: String
        get() = if (!toolCalls.isNullOrEmpty()) {
            val builder = StringBuilder()
            if (text.isNotEmpty()) builder.append(text).append("\n")
            builder.append(formatToolCalls())
            builder.toString()
        } else {
            text
        }

    private fun formatToolCalls(): String = try {
        val arr = JSONArray(toolCalls)
        val calls = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val call = arr.getJSONObject(i)
            val func = call.getJSONObject("function")
            val name = func.optString("name")
            var args = func.optString("arguments")
            args = try {
                JSONObject(args).toString(2)
            } catch (_: Exception) {
                args
            }
            calls.add("$name\n```\n$args\n```")
        }
        calls.joinToString("\n")
    } catch (_: Exception) {
        toolCalls ?: ""
    }
}

