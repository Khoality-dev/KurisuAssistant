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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import com.kurisuassistant.android.utils.HttpClient

/**
 * Singleton repository that manages chat messages and communicates with [Agent].
 */
object ChatRepository {
    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages
    private var currentIndex = 0
    private var pollJob: Job? = null
    private var isProcessing = false

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

    /**
     * Resolve conflicts between local cache messages and server messages using message hashes
     */
    private fun resolveMessageConflicts(localMessages: MutableList<ChatMessage>, serverMessages: MutableList<ChatMessage>): MutableList<ChatMessage> {
        // Create a map of message hashes to messages for efficient lookup
        val localMessageMap = mutableMapOf<String, ChatMessage>()
        val serverMessageMap = mutableMapOf<String, ChatMessage>()
        
        // Build maps using message hashes - all messages should have hashes from server
        localMessages.forEach { message ->
            message.messageHash?.let { hash ->
                localMessageMap[hash] = message
            }
        }
        
        serverMessages.forEach { message ->
            message.messageHash?.let { hash ->
                serverMessageMap[hash] = message
            }
        }
        
        // Create merged list prioritizing server messages for conflicts
        val mergedMessages = mutableListOf<ChatMessage>()
        val processedHashes = mutableSetOf<String>()
        
        // Add all server messages first (they are authoritative)
        serverMessages.forEach { serverMessage ->
            mergedMessages.add(serverMessage)
            serverMessage.messageHash?.let { hash ->
                processedHashes.add(hash)
            }
        }
        
        // Add local messages that don't exist on server (e.g., pending messages without hashes)
        localMessages.forEach { localMessage ->
            val hash = localMessage.messageHash
            if (hash == null || !processedHashes.contains(hash)) {
                mergedMessages.add(localMessage)
                hash?.let { processedHashes.add(it) }
            }
        }
        
        // Sort by created_at to ensure proper chronological order
        mergedMessages.sortBy { it.createdAt }
        
        return mergedMessages
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
     * Load older messages for scroll-up pagination
     * Returns true if more messages were loaded, false if none available
     */
    fun loadOlderMessages(callback: (Boolean) -> Unit) {
        val conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
            ChatHistory.getConversationId(currentIndex)
        } else null
        
        if (conversationId == null) {
            callback(false)
            return
        }
        
        scope.launch {
            try {
                val currentMessages = _messages.value ?: mutableListOf()
                val offset = currentMessages.size
                
                val olderMessages = ChatHistory.fetchConversationById(conversationId, limit = 20, offset = offset, reverse = true)
                
                if (olderMessages != null && olderMessages.isNotEmpty()) {
                    // Prepend older messages to the beginning of current messages
                    val updatedMessages = mutableListOf<ChatMessage>()
                    updatedMessages.addAll(olderMessages)
                    updatedMessages.addAll(currentMessages)
                    
                    // Sort by created_at to ensure proper chronological order
                    updatedMessages.sortBy { it.createdAt }
                    
                    // Update UI and local storage
                    _messages.postValue(ArrayList(updatedMessages))
                    ChatHistory.update(currentIndex, updatedMessages)
                    
                    withContext(Dispatchers.Main) {
                        callback(true)
                    }
                } else {
                    withContext(Dispatchers.Main) {
                        callback(false)
                    }
                }
            } catch (e: Exception) {
                println("ChatRepository: Error loading older messages: ${e.message}")
                withContext(Dispatchers.Main) {
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
                ChatHistory.fetchFromServer()
                if (ChatHistory.size > 0) {
                    // Start with the newest conversation (last index)
                    currentIndex = ChatHistory.size - 1
                    val initialMessages = ChatHistory.get(currentIndex)
                    _messages.postValue(ArrayList(initialMessages))
                    
                    // No loading placeholder logic needed
                    
                    startPolling(currentIndex)
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
    
    fun refreshConversations(onComplete: () -> Unit) {
        scope.launch {
            try {
                val oldCurrentIndex = currentIndex
                println("ChatRepository: Refreshing conversations, current index: $oldCurrentIndex")
                
                // Fetch fresh conversations from server
                ChatHistory.fetchFromServer()
                
                // Ensure current conversation is still valid after refresh
                if (oldCurrentIndex >= ChatHistory.size) {
                    // If current conversation no longer exists, switch to newest
                    currentIndex = if (ChatHistory.size > 0) ChatHistory.size - 1 else 0
                    println("ChatRepository: Current conversation no longer exists, switching to index $currentIndex")
                } else {
                    currentIndex = oldCurrentIndex
                }
                
                // Refresh current conversation messages
                if (ChatHistory.size > 0) {
                    val conversationMessages = ChatHistory.get(currentIndex)
                    println("ChatRepository: Refreshed conversation has ${conversationMessages.size} messages")
                    _messages.postValue(ArrayList(conversationMessages))
                }
                
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

    /**
     * Send a user text message to the LLM and stream the assistant reply.
     * Returns true if message was sent, false if already processing.
     */
    fun sendMessage(text: String): Boolean {
        // Prevent concurrent processing
        if (isProcessing) {
            return false
        }
        
        isProcessing = true
        val list = _messages.value ?: mutableListOf()
        list.add(ChatMessage(text, "user", Instant.now().toString()))
        // postValue ensures this can be called from background threads
        _messages.postValue(ArrayList(list))
        
        // Ensure we have a valid conversation index
        if (currentIndex < 0 || currentIndex >= ChatHistory.size) {
            currentIndex = ChatHistory.add()
        }
        ChatHistory.update(currentIndex, list)

        scope.launch {
            try {
                // Get conversation ID if we have one
                val conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                    ChatHistory.getConversationId(currentIndex)
                } else null
                
                val channel: Channel<ChatMessage> = agent.chat(text, conversationId)
                var assistant: ChatMessage? = null
                var idx = -1
                for (msg in channel) {
                    when (msg.role) {
                        "assistant" -> {
                            if (assistant == null) {
                                assistant = ChatMessage("", "assistant", msg.createdAt)
                                list.add(assistant!!)
                                idx = list.lastIndex
                            }
                            val updatedAssistant = assistant!!.copy(
                                text = assistant!!.text + msg.text,
                                toolCalls = msg.toolCalls ?: assistant!!.toolCalls,
                            )
                            updatedAssistant.conversationId = assistant!!.conversationId
                            assistant = updatedAssistant
                            list[idx] = assistant!!
                            if (msg.toolCalls != null) {
                                assistant = null
                                idx = -1
                            }
                        }
                        "tool" -> {
                            list.add(msg)
                            assistant = null
                            idx = -1
                        }
                        "system" -> {
                            // Handle conversation ID from system message
                            msg.conversationId?.let { convId ->
                                println("ChatRepository: Received conversation ID: $convId")
                                if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                                    ChatHistory.setConversationId(currentIndex, convId)
                                }
                            }
                            continue // Don't add system messages to the UI
                        }
                    }
                    _messages.postValue(ArrayList(list))
                    if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                        ChatHistory.update(currentIndex, list)
                    }
                }
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
        startPolling(currentIndex)
    }

    fun switchConversation(index: Int) {
        if (index == currentIndex || index < 0 || index >= ChatHistory.size) {
            println("ChatRepository: Cannot switch conversation - index=$index, current=$currentIndex, size=${ChatHistory.size}")
            return
        }
        
        println("ChatRepository: Switching from conversation $currentIndex to $index")
        
        // Reset processing flag when switching conversations
        isProcessing = false
        
        ChatHistory.update(currentIndex, _messages.value ?: mutableListOf())
        currentIndex = index
        
        // Get conversation messages and post immediately
        val conversationMessages = ChatHistory.get(index)
        println("ChatRepository: Loading ${conversationMessages.size} messages for conversation $index")
        _messages.postValue(ArrayList(conversationMessages))
        
        // No loading placeholder logic needed
        
        startPolling(currentIndex)
    }

    fun deleteConversation(index: Int, onComplete: (Boolean) -> Unit) {
        scope.launch {
            try {
                val success = ChatHistory.deleteConversation(index)
                
                // If we deleted the current conversation, switch to another one
                if (index == currentIndex) {
                    val newSize = ChatHistory.size
                    if (newSize > 0) {
                        // Switch to the previous conversation or the first one
                        val newIndex = if (index > 0) index - 1 else 0
                        currentIndex = newIndex
                        val conversationMessages = ChatHistory.get(newIndex)
                        _messages.postValue(ArrayList(conversationMessages))
                        startPolling(currentIndex)
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

    private fun startPolling(index: Int) {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (currentIndex == index) {
                // Only update from server if not currently processing a message
                if (!isProcessing) {
                    try {
                        val conversationId = ChatHistory.getConversationId(index)
                        val serverMessages = if (conversationId != null) {
                            ChatHistory.fetchConversationById(conversationId)
                        } else {
                            ChatHistory.fetchConversation(index)
                        }
                        
                        serverMessages?.let { messages ->
                            val currentMessages = _messages.value ?: mutableListOf()
                            // Resolve conflicts between local cache and server messages using message hashes
                            val mergedMessages = resolveMessageConflicts(currentMessages, messages)
                            if (mergedMessages.size > currentMessages.size) {
                                _messages.postValue(ArrayList(mergedMessages))
                            }
                        }
                    } catch (e: Exception) {
                        // If fetching fails, don't crash but log error
                        println("Error fetching conversation: ${e.message}")
                    }
                }
                delay(1000)
            }
        }
    }
}
