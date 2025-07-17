package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences
import com.kurisuassistant.android.model.ChatMessage
import com.kurisuassistant.android.utils.HttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
    private val conversationIds = mutableListOf<Int?>()

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
                            if (obj.getBoolean("isUser")) "user" else "assistant",
                            obj.optString("created_at", null)
                        )
                    )
                }
                conversations.add(convo)
                titles.add(convo.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${i + 1}")
                conversationIds.add(null) // Legacy conversations don't have IDs
            } else {
                val obj = arr.getJSONObject(i)
                val title = obj.optString("title")
                val convoArr = obj.getJSONArray("messages")
                val convo = mutableListOf<ChatMessage>()
                for (j in 0 until convoArr.length()) {
                    val msg = convoArr.getJSONObject(j)
                    val role = msg.optString("role", if (msg.optBoolean("isUser", false)) "user" else "assistant")
                    convo.add(
                        ChatMessage(
                            msg.optString("text", msg.optString("content")),
                            role,
                            msg.optString("created_at", null),
                            msg.optJSONArray("tool_calls")?.toString()
                        )
                    )
                }
                conversations.add(convo)
                titles.add(title.ifEmpty { convo.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${i + 1}" })
                conversationIds.add(obj.optInt("id", -1).takeIf { it != -1 })
            }
        }
        if (conversations.isEmpty()) {
            conversations.add(mutableListOf())
            titles.add("Conversation 1")
            conversationIds.add(null)
        }
    }

    suspend fun fetchFromServer() = withContext(Dispatchers.IO) {
        try {
            HttpClient.getResponse("${Settings.llmUrl}/conversations", Auth.token).use { resp ->
                if (!resp.isSuccessful) return@withContext
                val arr = JSONArray(resp.body!!.string())
                conversations.clear()
                titles.clear()
                conversationIds.clear()
                
                for (i in 0 until arr.length()) {
                    val convoObj = arr.getJSONObject(i)
                    val title = convoObj.optString("title")
                    val id = convoObj.optInt("id", -1).takeIf { it != -1 }
                    val messageCount = convoObj.optInt("message_count", 0)
                    
                    // For the list view, we don't need to load all messages
                    // We'll load them when the conversation is actually opened
                    val convo = mutableListOf<ChatMessage>()
                    
                    // Add a placeholder if there are messages, so it's not considered "new"
                    if (messageCount > 0) {
                        convo.add(ChatMessage("Loading...", "system", null))
                    }
                    
                    conversations.add(convo)
                    titles.add(title)
                    conversationIds.add(id)
                }
                
                if (conversations.isEmpty()) {
                    conversations.add(mutableListOf())
                    titles.add("New conversation")
                    conversationIds.add(null)
                }
                persist()
            }
        } catch (e: Exception) {
            println("Error fetching conversations: ${e.message}")
        }
    }

    suspend fun fetchConversation(index: Int): MutableList<ChatMessage>? {
        val conversationId = conversationIds.getOrNull(index)
        if (conversationId != null) {
            val messages = fetchConversationById(conversationId)
            if (messages != null) {
                // Update the local conversation with full messages
                conversations[index] = messages
                persist() // Save the updated conversation
                return messages
            }
        }
        return conversations.getOrNull(index)
    }

    suspend fun fetchConversationById(conversationId: Int): MutableList<ChatMessage>? = withContext(Dispatchers.IO) {
        try {
            val url = "${Settings.llmUrl}/conversations/$conversationId"
            println("Fetching conversation from: $url")
            HttpClient.getResponse(url, Auth.token).use { resp ->
                if (!resp.isSuccessful) {
                    println("Failed to fetch conversation $conversationId: ${resp.code} ${resp.message}")
                    return@withContext null
                }
                val responseBody = resp.body!!.string()
                println("Response body: $responseBody")
                val convoObj = JSONObject(responseBody)
                val convoArr = convoObj.getJSONArray("messages")
                val convo = mutableListOf<ChatMessage>()
                println("Found ${convoArr.length()} messages in conversation $conversationId")
                for (j in 0 until convoArr.length()) {
                    val obj = convoArr.getJSONObject(j)
                    val role = obj.optString("role")
                    val content = obj.optString("content")
                    val created = obj.optString("created_at", null)
                    val toolCalls = obj.optJSONArray("tool_calls")?.toString()
                    println("Message $j: role=$role, content=${content.take(50)}...")
                    convo.add(ChatMessage(content, role, created, toolCalls))
                }
                println("Loaded ${convo.size} messages for conversation $conversationId")
                return@withContext convo
            }
        } catch (e: Exception) {
            println("Error fetching conversation $conversationId: ${e.message}")
            e.printStackTrace()
            return@withContext null
        }
    }

    private fun persist() {
        val arr = JSONArray()
        for (i in conversations.indices) {
            val convo = conversations[i]
            val convoObj = JSONObject()
            convoObj.put("title", titles.getOrElse(i) { "" })
            conversationIds.getOrNull(i)?.let { convoObj.put("id", it) }
            val convoArr = JSONArray()
            for (msg in convo) {
                val obj = JSONObject()
                obj.put("role", msg.role)
                obj.put("content", msg.text)
                if (msg.createdAt != null) obj.put("created_at", msg.createdAt)
                if (msg.toolCalls != null) obj.put("tool_calls", JSONArray(msg.toolCalls))
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
            else "New conversation"
        }

    fun indexFromNewest(displayIndex: Int): Int = conversations.lastIndex - displayIndex

    fun get(index: Int): MutableList<ChatMessage> {
        println("ChatHistory: Getting conversation $index, total conversations: ${conversations.size}")
        if (index >= 0 && index < conversations.size) {
            val conversation = conversations[index]
            println("ChatHistory: Conversation $index has ${conversation.size} messages")
            return conversation
        } else {
            println("ChatHistory: Index $index out of bounds")
            return mutableListOf()
        }
    }

    fun update(index: Int, messages: MutableList<ChatMessage>) {
        if (index >= 0 && index < conversations.size) {
            conversations[index] = messages
            if (index < titles.size && titles[index].isEmpty()) {
                titles[index] = messages.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${index + 1}"
            }
            persist()
        } else {
            println("ChatHistory: Invalid index $index for update, size: ${conversations.size}")
        }
    }

    fun add(): Int {
        conversations.add(mutableListOf())
        titles.add("")
        conversationIds.add(null)
        persist()
        return conversations.lastIndex
    }

    fun getConversationId(index: Int): Int? {
        return conversationIds.getOrNull(index)
    }

    fun setConversationId(index: Int, id: Int) {
        if (index >= 0 && index < conversationIds.size) {
            conversationIds[index] = id
            persist()
        }
    }

    suspend fun deleteConversation(index: Int): Boolean = withContext(Dispatchers.IO) {
        if (index < 0 || index >= conversations.size) return@withContext false
        
        val conversationId = conversationIds[index]
        var success = true
        
        // Delete from server if conversation has an ID
        if (conversationId != null) {
            try {
                HttpClient.deleteRequest("${Settings.llmUrl}/conversation/$conversationId", Auth.token).use { resp ->
                    success = resp.isSuccessful
                }
            } catch (e: Exception) {
                println("Error deleting conversation from server: ${e.message}")
                success = false
            }
        }
        
        // Remove from local storage regardless of server result
        conversations.removeAt(index)
        titles.removeAt(index)
        conversationIds.removeAt(index)
        persist()
        
        return@withContext success
    }

    val size: Int
        get() = conversations.size
    
    fun getCurrentConversationTitle(index: Int): String {
        return if (index >= 0 && index < titles.size) {
            val title = titles[index]
            if (title.isNotEmpty()) title else "New conversation"
        } else {
            "New conversation"
        }
    }
    
    fun isNewConversation(index: Int): Boolean {
        return if (index >= 0 && index < conversations.size) {
            val conversation = conversations[index]
            // A conversation is new if it's empty or only has the "Loading..." placeholder
            val isNew = conversation.isEmpty() || (conversation.size == 1 && conversation[0].text == "Loading...")
            println("ChatHistory: isNewConversation($index) = $isNew, messages: ${conversation.size}")
            if (conversation.isNotEmpty()) {
                println("ChatHistory: First message: ${conversation[0].text}")
            }
            isNew
        } else {
            println("ChatHistory: isNewConversation($index) = true (out of bounds)")
            true
        }
    }
}
