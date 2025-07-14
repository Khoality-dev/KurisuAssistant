package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences
import com.kurisuassistant.android.model.ChatMessage
import com.kurisuassistant.android.utils.HttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
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
    private val titles = mutableListOf<String>()

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (conversations.isNotEmpty()) return
        val json = prefs.getString(KEY, "[]")
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val element = arr.get(i)
            if (element is JSONArray) {
                val convoArr = element
                val convo = mutableListOf<ChatMessage>()
                for (j in 0 until convoArr.length()) {
                    val obj = convoArr.getJSONObject(j)
                    convo.add(
                        ChatMessage(
                            obj.getString("text"),
                            obj.getBoolean("isUser"),
                            obj.optString("created_at", null)
                        )
                    )
                }
                conversations.add(convo)
                titles.add(convo.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${i + 1}")
            } else {
                val obj = arr.getJSONObject(i)
                val title = obj.optString("title")
                val convoArr = obj.getJSONArray("messages")
                val convo = mutableListOf<ChatMessage>()
                for (j in 0 until convoArr.length()) {
                    val msg = convoArr.getJSONObject(j)
                    convo.add(
                        ChatMessage(
                            msg.optString("text", msg.optString("content")),
                            msg.optBoolean("isUser", msg.optString("role") == "user"),
                            msg.optString("created_at", null)
                        )
                    )
                }
                conversations.add(convo)
                titles.add(title.ifEmpty { convo.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${i + 1}" })
            }
        }
        if (conversations.isEmpty()) {
            conversations.add(mutableListOf())
            titles.add("Conversation 1")
        }
    }

    suspend fun fetchFromServer() = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${Settings.llmUrl}/history")
            .build()
        try {
            HttpClient.noTimeout.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext
                val arr = JSONArray(resp.body!!.string())
                conversations.clear()
                titles.clear()
                for (i in 0 until arr.length()) {
                    val convoObj = arr.getJSONObject(i)
                    val title = convoObj.optString("title")
                    val convoArr = convoObj.getJSONArray("messages")
                    val convo = mutableListOf<ChatMessage>()
                    for (j in 0 until convoArr.length()) {
                        val obj = convoArr.getJSONObject(j)
                        val role = obj.optString("role")
                        val content = obj.optString("content")
                        val created = obj.optString("created_at", null)
                        when (role) {
                            "user" -> convo.add(ChatMessage(content, true, created))
                            "assistant" -> convo.add(ChatMessage(content, false, created))
                        }
                    }
                    conversations.add(convo)
                    titles.add(title)
                }
                if (conversations.isEmpty()) {
                    conversations.add(mutableListOf())
                    titles.add("Conversation 1")
                }
                persist()
            }
        } catch (_: Exception) {
            // ignore on failure
        }
    }

    suspend fun fetchConversation(index: Int): MutableList<ChatMessage>? {
        fetchFromServer()
        return conversations.getOrNull(index)
    }

    private fun persist() {
        val arr = JSONArray()
        for (i in conversations.indices) {
            val convo = conversations[i]
            val convoObj = JSONObject()
            convoObj.put("title", titles.getOrElse(i) { "" })
            val convoArr = JSONArray()
            for (msg in convo) {
                val obj = JSONObject()
                obj.put("text", msg.text)
                obj.put("isUser", msg.isUser)
                if (msg.createdAt != null) obj.put("created_at", msg.createdAt)
                convoArr.put(obj)
            }
            convoObj.put("messages", convoArr)
            arr.put(convoObj)
        }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    fun conversationTitles(): List<String> = titles
        .asReversed()
        .mapIndexed { index, title ->
            if (title.isNotEmpty()) title
            else "Conversation ${conversations.lastIndex - index + 1}"
        }

    fun indexFromNewest(displayIndex: Int): Int = conversations.lastIndex - displayIndex

    fun get(index: Int): MutableList<ChatMessage> = conversations[index]

    fun update(index: Int, messages: MutableList<ChatMessage>) {
        conversations[index] = messages
        if (titles[index].isEmpty()) {
            titles[index] = messages.firstOrNull { it.isUser }?.text?.take(30) ?: titles[index]
        }
        persist()
    }

    fun add(): Int {
        conversations.add(mutableListOf())
        titles.add("")
        persist()
        return conversations.lastIndex
    }

    val size: Int
        get() = conversations.size
}
