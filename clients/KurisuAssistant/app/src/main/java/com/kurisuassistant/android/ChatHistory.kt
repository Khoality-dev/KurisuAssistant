package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences
import com.kurisuassistant.android.model.ChatMessage
import org.json.JSONArray
import org.json.JSONObject

/**
 * Helper object to persist chat conversations.
 */
object ChatHistory {
    private const val PREFS = "chat_history"
    private const val KEY = "conversations"

    private lateinit var prefs: SharedPreferences
    private val conversations = mutableListOf<MutableList<ChatMessage>>()

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (conversations.isNotEmpty()) return
        val json = prefs.getString(KEY, "[]")
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val convoArr = arr.getJSONArray(i)
            val convo = mutableListOf<ChatMessage>()
            for (j in 0 until convoArr.length()) {
                val obj = convoArr.getJSONObject(j)
                convo.add(ChatMessage(obj.getString("text"), obj.getBoolean("isUser")))
            }
            conversations.add(convo)
        }
        if (conversations.isEmpty()) conversations.add(mutableListOf())
    }

    private fun persist() {
        val arr = JSONArray()
        for (convo in conversations) {
            val convoArr = JSONArray()
            for (msg in convo) {
                val obj = JSONObject()
                obj.put("text", msg.text)
                obj.put("isUser", msg.isUser)
                convoArr.put(obj)
            }
            arr.put(convoArr)
        }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    fun conversationTitles(): List<String> = conversations
        .asReversed()
        .mapIndexed { index, convo ->
            convo.firstOrNull { it.isUser }?.text?.take(30)
                ?: "Conversation ${conversations.lastIndex - index + 1}"
        }

    fun indexFromNewest(displayIndex: Int): Int = conversations.lastIndex - displayIndex

    fun get(index: Int): MutableList<ChatMessage> = conversations[index]

    fun update(index: Int, messages: MutableList<ChatMessage>) {
        conversations[index] = messages
        persist()
    }

    fun add(): Int {
        conversations.add(mutableListOf())
        persist()
        return conversations.lastIndex
    }

    val size: Int
        get() = conversations.size
}
