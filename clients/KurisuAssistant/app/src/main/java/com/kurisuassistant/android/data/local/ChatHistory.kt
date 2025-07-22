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
    private val conversations = mutableListOf<Conversation>()

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (conversations.isNotEmpty()) return
        val json = prefs.getString(KEY, "[]")
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val title = obj.optString("title")
            val id = obj.getInt("id") // Required field - will throw if missing
            conversations.add(Conversation(title.ifEmpty { "Conversation ${i + 1}" }, id))
        }
        if (conversations.isEmpty()) {
            conversations.add(Conversation.createNew("New conversation"))
        }
    }

    suspend fun fetchConversationList() = withContext(Dispatchers.IO) {
        try {
            HttpClient.getResponse("${Settings.llmUrl}/conversations", Auth.token).use { resp ->
                if (!resp.isSuccessful) return@withContext
                val arr = JSONArray(resp.body!!.string())
                conversations.clear()
                
                for (i in 0 until arr.length()) {
                    val convoObj = arr.getJSONObject(i)
                    val title = convoObj.optString("title")
                    val id = convoObj.getInt("id") // Required field - will throw if missing
                    val maxOffset = convoObj.optInt("max_offset", 0)
                    
                    conversations.add(Conversation(title, id, maxOffset, maxOffset))
                }
                
                if (conversations.isEmpty()) {
                    conversations.add(Conversation.createNew("New conversation"))
                }
                persist()
            }
        } catch (e: Exception) {
            println("Error fetching conversations: ${e.message}")
        }
    }

    suspend fun fetchConversationMessagesById(conversationId: Int, limit: Int = 5, offset: Int = 0): MutableList<ChatMessage>? = withContext(Dispatchers.IO) {
        try {
            // Always include pagination parameters to ensure we never fetch whole conversations
            // New pagination system uses normal chronological order (oldest first)
            val url = "${Settings.llmUrl}/conversations/$conversationId?limit=$limit&offset=$offset"
            println("Fetching conversation from: $url")
            HttpClient.getResponse(url, Auth.token).use { resp ->
                if (!resp.isSuccessful) {
                    println("Failed to fetch conversation $conversationId: ${resp.code} ${resp.message}")
                    return@withContext null
                }
                val responseBody = resp.body!!.string()
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
                    val messageId = obj.optInt("id", -1).takeIf { it != -1 }
                    println("Message $j: role=$role, content=${content.take(50)}..., id=$messageId")
                    convo.add(ChatMessage(content, role, created, toolCalls, false, messageId))
                }
                
                // Messages are already in chronological order from the new backend pagination system
                
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
        for (conversation in conversations) {
            val convoObj = JSONObject()
            convoObj.put("title", conversation.title)
            conversation.id?.let { convoObj.put("id", it) }
            // No messages stored locally - handled by ChatRepository
            arr.put(convoObj)
        }
        prefs.edit().putString(KEY, arr.toString()).apply()
    }

    fun conversationTitles(): List<String> = conversations.map { conversation ->
        if (conversation.title.isNotEmpty()) conversation.title
        else "New conversation"
    }

    fun indexFromNewest(displayIndex: Int): Int = displayIndex

    fun get(index: Int): MutableList<ChatMessage> {
        // Messages are now managed by ChatRepository deque system
        println("ChatHistory: get() is deprecated - messages handled by ChatRepository")
        return mutableListOf()
    }
    

    fun update(index: Int, messages: MutableList<ChatMessage>) {
        // Update conversation title if empty
        if (index >= 0 && index < conversations.size && conversations[index].title.isEmpty()) {
            val newTitle = messages.firstOrNull { it.isUser }?.text?.take(30) ?: "Conversation ${index + 1}"
            conversations[index] = conversations[index].copy(title = newTitle)
            persist()
        }
    }

    fun add(): Int {
        conversations.add(Conversation.createNew())
        persist()
        return conversations.lastIndex
    }

    fun getConversationId(index: Int): Int? {
        return conversations.getOrNull(index)?.id
    }
    
    fun getConversationByIndex(index: Int): Conversation? {
        return conversations.getOrNull(index)
    }
    
    fun getConversation(conversationId: Int): Conversation? {
        return conversations.find { it.id == conversationId }
    }

    fun setConversationId(index: Int, id: Int) {
        if (index >= 0 && index < conversations.size) {
            conversations[index] = conversations[index].copy(id = id)
            persist()
        }
    }

    suspend fun deleteConversation(index: Int): Boolean = withContext(Dispatchers.IO) {
        if (index < 0 || index >= conversations.size) return@withContext false
        
        val conversation = conversations[index]
        var success = true
        
        // Delete from server if conversation has an ID
        if (conversation.id != null) {
            try {
                HttpClient.deleteRequest("${Settings.llmUrl}/conversation/${conversation.id}", Auth.token).use { resp ->
                    success = resp.isSuccessful
                }
            } catch (e: Exception) {
                println("Error deleting conversation from server: ${e.message}")
                success = false
            }
        }
        
        // Remove from local storage regardless of server result
        conversations.removeAt(index)
        persist()
        
        return@withContext success
    }

    val size: Int
        get() = conversations.size
    
    fun getCurrentConversationTitle(index: Int): String {
        return if (index >= 0 && index < conversations.size) {
            val title = conversations[index].title
            if (title.isNotEmpty()) title else "New conversation"
        } else {
            "New conversation"
        }
    }
    
    fun isNewConversation(index: Int): Boolean {
        // A conversation is new if it has no server ID
        return if (index >= 0 && index < conversations.size) {
            val isNew = conversations[index].id == null
            println("ChatHistory: isNewConversation($index) = $isNew")
            isNew
        } else {
            println("ChatHistory: isNewConversation($index) = true (out of bounds)")
            true
        }
    }
}
