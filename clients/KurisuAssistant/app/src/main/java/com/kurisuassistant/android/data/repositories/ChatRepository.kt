package com.kurisuassistant.android

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.kurisuassistant.android.model.ChatMessage
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
// Removed Job import - no longer needed without polling
// Removed delay import - no longer needed without polling
import kotlinx.coroutines.withContext
import java.time.Instant
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import com.kurisuassistant.android.Settings
import com.kurisuassistant.android.Auth

/**
 * Singleton repository that manages chat messages and communicates with [Agent].
 */
object ChatRepository {
    private const val MESSAGES_PER_PAGE = 20 // Messages to fetch per page/screen
    
    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages
    private var currentIndex = 0
    // Removed polling - app now uses manual refresh only
    private var isProcessing = false
    private var isLoadingOlderMessages = false
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)  // Longer read timeout for streaming responses
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    
    
    private fun getCurrentConversation(): Conversation? {
        return ChatHistory.getConversationByIndex(currentIndex)
    }

    private val player: AudioTrack by lazy {
        AudioTrack.Builder()
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
            .build().apply { play() }
    }

    private val agent by lazy { Agent(player) }
    private val scope = CoroutineScope(Dispatchers.IO)

    private suspend fun createNewConversationOnServer(): Int? = withContext(Dispatchers.IO) {
        try {
            val requestBody = "".toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${Settings.llmUrl}/conversations")
                .post(requestBody)
                .addHeader("Authorization", "Bearer ${Auth.token}")
                .build()
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val responseBody = response.body?.string()
                    if (responseBody != null) {
                        val json = JSONObject(responseBody)
                        json.getInt("id")
                    } else null
                } else {
                    println("ChatRepository: Server error creating conversation: ${response.code}")
                    null
                }
            }
        } catch (e: Exception) {
            println("ChatRepository: Error creating conversation: ${e.message}")
            null
        }
    }


    val connected: LiveData<Boolean>
        get() = agent.connected
    val typing: LiveData<Boolean>
        get() = agent.typing
    val speaking: LiveData<Boolean>
        get() = agent.speaking

    private val _conversationActive = MutableLiveData(false)
    val conversationActive: LiveData<Boolean> = _conversationActive
    
    val isProcessingMessage: Boolean
        get() = isProcessing
    
    fun getCurrentConversationIndex(): Int = currentIndex
    
    /**
     * Fetch enough messages to fill a screen page, starting from the given offset and going backwards.
     * Continues fetching until MESSAGES_PER_PAGE messages are obtained or no more messages are available.
     */
    private suspend fun fetchMessagesForPage(conversation: Conversation): Boolean {
        if (conversation.id == null) return false
        
        val allMessages = mutableListOf<ChatMessage>()
        var currentOffset = conversation.maxOffset
        
        // Keep fetching backwards until we have enough messages or reach the beginning
        while (allMessages.size < MESSAGES_PER_PAGE && currentOffset >= 0) {
            val messages = ChatHistory.fetchConversationMessagesById(conversation.id, limit = MESSAGES_PER_PAGE, offset = currentOffset)
            
            if (messages != null && messages.isNotEmpty()) {
                // Add messages at the beginning since we're going backwards in offset
                allMessages.addAll(0, messages)
                currentOffset = currentOffset - MESSAGES_PER_PAGE
            } else {
                break
            }
        }
        
        return if (allMessages.isNotEmpty()) {
            conversation.replaceMessages(allMessages)
            // Set nextFetchOffset to continue from where we stopped
            conversation.nextFetchOffset = currentOffset
            _messages.postValue(ArrayList(conversation.messages))
            println("ChatRepository: Loaded ${allMessages.size} messages from offset ${conversation.maxOffset}")
            true
        } else {
            false
        }
    }
    
    /**
     * Load older messages for scroll-up pagination
     * Returns true if more messages were loaded, false if none available
     */
    fun loadOlderMessages(callback: (Boolean) -> Unit) {
        if (isLoadingOlderMessages) {
            callback(false)
            return
        }
        
        val conversation = getCurrentConversation()
        if (conversation?.id == null) {
            callback(false)
            return
        }
        
        isLoadingOlderMessages = true
        
        scope.launch {
            try {
                // Get next page-aligned offset to fetch (decrement by MESSAGES_PER_PAGE)
                if (conversation.nextFetchOffset < 0) {
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(false)
                    }
                    return@launch
                }
                
                val offset = maxOf(0, conversation.nextFetchOffset - MESSAGES_PER_PAGE)
                
                // Fetch older messages using page-aligned limit
                val olderMessages = ChatHistory.fetchConversationMessagesById(conversation.id, limit = MESSAGES_PER_PAGE, offset = offset)
                
                if (olderMessages != null && olderMessages.isNotEmpty()) {
                    // Update next fetch offset to the current page start
                    conversation.nextFetchOffset = offset
                    
                    // Push older messages to beginning
                    conversation.addMessagesAtBeginning(olderMessages)
                    
                    // Update UI
                    _messages.postValue(ArrayList(conversation.messages))
                    
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(true)
                    }
                } else {
                    // No more messages available - set to -1 to indicate we've reached the beginning
                    conversation.nextFetchOffset = -1
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(false)
                    }
                }
            } catch (e: Exception) {
                println("ChatRepository: Error loading older messages: ${e.message}")
                withContext(Dispatchers.Main) {
                    isLoadingOlderMessages = false
                    callback(false)
                }
            }
        }
    }

    fun init(context: Context? = null) {
        agent
        context?.let { ChatHistory.init(it) }
        if (context != null) {
            scope.launch {
                ChatHistory.fetchConversationList()
                if (ChatHistory.size > 0) {
                    // Start with the newest conversation (last index)
                    currentIndex = ChatHistory.size - 1
                    
                    // Fetch enough messages to fill screen using backend-provided starting offset
                    val conversation = getCurrentConversation()
                    if (conversation != null) {
                        fetchMessagesForPage(conversation)
                    }
                } else {
                    // No conversations exist, start with a new one
                    startNewConversation()
                }
            }
        }
    }

    fun setConversationActive(active: Boolean) {
        _conversationActive.postValue(active)
    }
    
    fun refreshConversationList(onComplete: () -> Unit) {
        scope.launch {
            try {
                val oldCurrentIndex = currentIndex
                println("ChatRepository: Refreshing conversations, current index: $oldCurrentIndex")
                
                // Fetch fresh conversations from server
                ChatHistory.fetchConversationList()
                
                // Ensure current conversation is still valid after refresh
                if (oldCurrentIndex >= ChatHistory.size) {
                    // If current conversation no longer exists, switch to newest
                    currentIndex = if (ChatHistory.size > 0) ChatHistory.size - 1 else 0
                    println("ChatRepository: Current conversation no longer exists, switching to index $currentIndex")
                } else {
                    currentIndex = oldCurrentIndex
                }
                
                // Don't refresh messages here - that's handled by refreshConversationMessages
                println("ChatRepository: Conversation list refreshed, current conversation index: $currentIndex")
                
                // Call completion callback on main thread
                withContext(Dispatchers.Main) {
                    onComplete()
                }
            } catch (e: Exception) {
                println("ChatRepository: Error refreshing conversations: ${e.message}")
                withContext(Dispatchers.Main) {
                    onComplete()
                }
            }
        }
    }
    
    fun refreshConversationMessages(callback: (Boolean) -> Unit) {
        val conversation = getCurrentConversation()
        if (conversation?.id == null || conversation.messageCount == 0) {
            callback(false)
            return
        }
        
        scope.launch {
            try {
                // Refetch all messages we currently have
                val currentMessageCount = conversation.messageCount
                val fetchOffset = maxOf(0, conversation.maxOffset - currentMessageCount)
                
                val freshMessages = ChatHistory.fetchConversationMessagesById(conversation.id, limit = currentMessageCount, offset = fetchOffset)
                if (freshMessages != null && freshMessages.isNotEmpty()) {
                    // Replace conversation messages with fresh data
                    conversation.replaceMessages(freshMessages)
                    
                    _messages.postValue(ArrayList(conversation.messages))
                    println("ChatRepository: Refreshed ${freshMessages.size} conversation messages")
                    
                    withContext(Dispatchers.Main) {
                        callback(true)
                    }
                } else {
                    withContext(Dispatchers.Main) {
                        callback(false)
                    }
                }
            } catch (e: Exception) {
                println("ChatRepository: Error refreshing conversation messages: ${e.message}")
                withContext(Dispatchers.Main) {
                    callback(false)
                }
            }
        }
    }

    /**
     * Send a user text message to the LLM and stream the assistant reply.
     * Returns true if message was sent, false if already processing.
     */
    fun sendMessage(text: String): Boolean {
        // Prevent concurrent processing
        if (isProcessing) {
            return false
        }
        
        // Check connection status before sending
        if (connected.value != true) {
            return false
        }
        
        isProcessing = true
        
        // Ensure we have a valid conversation index
        if (currentIndex < 0 || currentIndex >= ChatHistory.size) {
            currentIndex = ChatHistory.add()
        }
        
        val conversation = getCurrentConversation()

        scope.launch {
            try {
                // Get conversation ID, create new conversation if needed
                var conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                    ChatHistory.getConversationId(currentIndex)
                } else null
                
                // If conversation ID is null, create a new conversation first
                if (conversationId == null) {
                    try {
                        conversationId = createNewConversationOnServer()
                        if (conversationId != null && currentIndex >= 0 && currentIndex < ChatHistory.size) {
                            ChatHistory.setConversationId(currentIndex, conversationId)
                        } else {
                            println("ChatRepository: Failed to create new conversation")
                            isProcessing = false
                            return@launch
                        }
                    } catch (e: Exception) {
                        println("ChatRepository: Failed to create new conversation: ${e.message}")
                        isProcessing = false
                        return@launch
                    }
                }
                
                val channel: Channel<ChatMessage> = agent.chat(text, conversationId)
                var streamingAssistant: ChatMessage? = null
                for (msg in channel) {
                    when (msg.role) {
                        "assistant" -> {
                            if (streamingAssistant == null) {
                                // First assistant message chunk - add new message
                                streamingAssistant = ChatMessage(msg.text, "assistant", msg.createdAt, false, msg.messageId)
                                conversation?.addMessage(streamingAssistant)
                            } else {
                                // Subsequent chunks - update the existing assistant message
                                val updatedAssistant = streamingAssistant.copy(
                                    text = streamingAssistant.text + msg.text
                                )
                                updatedAssistant.conversationId = streamingAssistant.conversationId
                                streamingAssistant = updatedAssistant
                                
                                // Update only the last assistant message without affecting other messages
                                if (conversation != null && conversation.messageCount > 0) {
                                    val messages = conversation.messages.toMutableList()
                                    // Find the last message that matches our streaming assistant
                                    for (i in messages.indices.reversed()) {
                                        if (messages[i].role == "assistant" && messages[i].messageId == streamingAssistant.messageId) {
                                            messages[i] = streamingAssistant
                                            break
                                        }
                                    }
                                    conversation.replaceMessages(messages)
                                }
                            }
                        }
                        "tool" -> {
                            // Tool messages are complete when received - add directly
                            conversation?.addMessage(msg)
                        }
                        "user" -> {
                            // User messages are complete when received - add directly
                            conversation?.addMessage(msg)
                        }
                        else -> {
                            // Any other role - add directly
                            conversation?.addMessage(msg)
                        }
                    }
                   
                    // Update UI with conversation messages
                    if (conversation != null) {
                        _messages.postValue(ArrayList(conversation.messages))
                        if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                            ChatHistory.update(currentIndex, conversation.messages.toMutableList())
                        }
                    }
                }
                
                // Streaming finished - messages are already saved with database IDs
                println("ChatRepository: Streaming finished")
            } finally {
                // Always reset processing flag when done
                isProcessing = false
            }
        }
        return true
    }


    fun startNewConversation() {
        // Reset processing flag when starting new conversation
        isProcessing = false
        
        // Add to local history without server ID initially
        currentIndex = ChatHistory.add()
        
        _messages.postValue(mutableListOf())
        // Removed auto-polling - messages load on demand
    }

    fun switchConversation(index: Int) {
        if (index == currentIndex || index < 0 || index >= ChatHistory.size) {
            println("ChatRepository: Cannot switch conversation - index=$index, current=$currentIndex, size=${ChatHistory.size}")
            return
        }
        
        println("ChatRepository: Switching from conversation $currentIndex to $index")
        
        // Reset processing flag when switching conversations
        isProcessing = false
        
        // Save current conversation before switching
        val currentConversationId = ChatHistory.getConversationId(currentIndex)
        ChatHistory.update(currentIndex, _messages.value ?: mutableListOf())
        currentIndex = index
        
        // Load conversation messages efficiently - check if already loaded
        scope.launch {
            try {
                val newConversation = ChatHistory.getConversationByIndex(index)
                if (newConversation != null) {
                    // Check if conversation already has messages loaded
                    if (newConversation.messageCount > 0) {
                        println("ChatRepository: Found ${newConversation.messageCount} stored messages for conversation $index")
                        _messages.postValue(ArrayList(newConversation.messages))
                        return@launch
                    }
                
                    // No stored messages - fetch from server
                    if (newConversation.id != null) {
                        val success = fetchMessagesForPage(newConversation)
                        if (!success) {
                            _messages.postValue(ArrayList<ChatMessage>())
                        }
                    } else {
                        _messages.postValue(ArrayList<ChatMessage>())
                    }
                } else {
                    _messages.postValue(ArrayList<ChatMessage>())
                }
            } catch (e: Exception) {
                println("ChatRepository: Error loading conversation $index: ${e.message}")
                // Fallback to local recent messages if network fetch fails
                val localMessages = ChatHistory.get(index).takeLast(5) // Only take last 5 messages
                _messages.postValue(ArrayList(localMessages))
            }
        }
        
        // Removed auto-polling - messages load on demand
    }

    fun deleteConversation(index: Int, onComplete: (Boolean) -> Unit) {
        scope.launch {
            try {
                // Messages are now managed by the Conversation object itself
                // No need to manually clear - will be garbage collected when conversation is removed
                println("ChatRepository: Deleting conversation $index")
                
                val success = ChatHistory.deleteConversation(index)
                
                // If we deleted the current conversation, switch to first available or create new
                if (index == currentIndex) {
                    if (ChatHistory.size > 0) {
                        // Switch to first conversation
                        currentIndex = 0
                        switchConversation(0)
                    } else {
                        // No conversations left, start a new one
                        startNewConversation()
                    }
                } else if (index < currentIndex) {
                    // Adjust current index if we deleted a conversation before it
                    currentIndex--
                }
                
                withContext(Dispatchers.Main) {
                    onComplete(success)
                }
            } catch (e: Exception) {
                println("Error deleting conversation: ${e.message}")
                withContext(Dispatchers.Main) {
                    onComplete(false)
                }
            }
        }
    }

    fun destroy() {
        agent.destroy()
        player.stop()
        player.release()
    }
}
