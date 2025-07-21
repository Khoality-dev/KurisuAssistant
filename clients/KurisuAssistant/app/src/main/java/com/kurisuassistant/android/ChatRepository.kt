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
import org.json.JSONObject
import com.kurisuassistant.android.utils.HttpClient
import com.kurisuassistant.android.Settings
import com.kurisuassistant.android.Auth

/**
 * Singleton repository that manages chat messages and communicates with [Agent].
 */
object ChatRepository {
    private val _messages = MutableLiveData<MutableList<ChatMessage>>(mutableListOf())
    val messages: LiveData<MutableList<ChatMessage>> = _messages
    private var currentIndex = 0
    // Removed polling - app now uses manual refresh only
    private var isProcessing = false
    private var isLoadingOlderMessages = false
    private var totalMessagesFetched = 0 // Track total messages fetched for proper offset calculation
    
    // Progressive message store for all conversations (persistent across app usage)
    private val conversationMessages = mutableMapOf<Int, MutableList<ChatMessage>>()
    private val messageIdMap = mutableMapOf<Int, ChatMessage>() // Global message ID to message mapping
    private var highestKnownMessageId = 0 // Track highest message ID we've seen
    private val totalMessageCounts = mutableMapOf<Int, Int>() // Track total message count per conversation
    private val fetchedOffsets = mutableMapOf<Int, MutableSet<Int>>() // Track which offsets have been fetched per conversation
    private val conversationPageCounts = mutableMapOf<Int, Int>() // Track total pages per conversation

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
     * Get messages for a conversation from the progressive store
     */
    private fun getStoredMessages(conversationId: Int): MutableList<ChatMessage> {
        return conversationMessages[conversationId]?.toMutableList() ?: mutableListOf()
    }
    
    /**
     * Set total message count for a conversation
     */
    fun setTotalMessageCount(conversationId: Int, totalCount: Int) {
        totalMessageCounts[conversationId] = totalCount
        println("ChatRepository: Set total message count for conversation $conversationId to $totalCount")
    }
    
    /**
     * Get total message count for a conversation
     */
    fun getTotalMessageCount(conversationId: Int): Int {
        return totalMessageCounts[conversationId] ?: 0
    }
    
    /**
     * Calculate page number from offset and limit
     */
    private fun calculatePageNumber(offset: Int, limit: Int = 5): Int {
        return offset / limit
    }
    
    /**
     * Calculate total pages for a conversation
     */
    private fun calculateTotalPages(conversationId: Int, limit: Int = 5): Int {
        val totalMessages = getTotalMessageCount(conversationId)
        return if (totalMessages > 0) {
            (totalMessages + limit - 1) / limit // Ceiling division
        } else {
            0
        }
    }
    
    /**
     * Check if an offset has been fetched for a conversation
     */
    private fun isOffsetFetched(conversationId: Int, offset: Int): Boolean {
        return fetchedOffsets[conversationId]?.contains(offset) == true
    }
    
    /**
     * Mark an offset as fetched for a conversation
     */
    private fun markOffsetFetched(conversationId: Int, offset: Int) {
        fetchedOffsets.getOrPut(conversationId) { mutableSetOf() }.add(offset)
        
        // Update total page count
        val totalPages = calculateTotalPages(conversationId)
        conversationPageCounts[conversationId] = totalPages
        
        val pageNumber = calculatePageNumber(offset)
        println("ChatRepository: Marked offset $offset (page $pageNumber) as fetched for conversation $conversationId (${fetchedOffsets[conversationId]?.size} offsets fetched)")
    }
    
    /**
     * Get fetched offsets for a conversation
     */
    fun getFetchedOffsets(conversationId: Int): Set<Int> {
        return fetchedOffsets[conversationId]?.toSet() ?: emptySet()
    }
    
    /**
     * Get total pages for a conversation
     */
    fun getTotalPages(conversationId: Int): Int {
        return conversationPageCounts[conversationId] ?: calculateTotalPages(conversationId)
    }
    
    /**
     * Clear offset tracking for a conversation (when deleted)
     */
    private fun clearOffsetTracking(conversationId: Int) {
        fetchedOffsets.remove(conversationId)
        conversationPageCounts.remove(conversationId)
        println("ChatRepository: Cleared offset tracking for conversation $conversationId")
    }
    
    
    /**
     * Fetch new complete messages after chat streaming finishes
     * Uses progressive fetching from highest known message ID
     */
    private suspend fun fetchNewCompleteMessages() = withContext(Dispatchers.IO) {
        val conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
            ChatHistory.getConversationId(currentIndex)
        } else null
        
        if (conversationId == null) {
            println("ChatRepository: No conversation ID for fetching complete messages")
            return@withContext
        }
        
        val currentMessages = _messages.value ?: mutableListOf()
        
        // Use the highest known message ID from our progressive store, or fall back to current messages
        var startingMessageId = if (highestKnownMessageId > 0) {
            highestKnownMessageId + 1
        } else {
            currentMessages.mapNotNull { it.messageId }.maxOrNull()?.plus(1) ?: 1
        }
        
        println("ChatRepository: Starting to fetch new messages from ID: $startingMessageId")
        
        val newMessages = mutableListOf<ChatMessage>()
        var messageId = startingMessageId
        
        // Fetch messages one by one until we don't find any more
        var shouldContinue = true
        while (shouldContinue) {
            try {
                val url = "${Settings.llmUrl}/messages/$messageId"
                val response = HttpClient.getResponse(url, Auth.token)
                
                if (!response.isSuccessful) {
                    response.close()
                    if (response.code == 404) {
                        // No more messages found
                        println("ChatRepository: No more new messages found after ID: ${messageId - 1}")
                        shouldContinue = false
                    } else {
                        println("ChatRepository: Error fetching message $messageId: ${response.code}")
                        shouldContinue = false
                    }
                } else {
                    val responseBody = response.body!!.string()
                    response.close()
                    
                    val messageObj = JSONObject(responseBody)
                    
                    // Check if this message belongs to our conversation
                    val msgConversationId = messageObj.optInt("conversation_id", -1)
                    if (msgConversationId != conversationId) {
                        println("ChatRepository: Message $messageId belongs to different conversation ($msgConversationId vs $conversationId)")
                        messageId++
                        // Continue to next iteration
                    } else {
                        val role = messageObj.optString("role")
                        val content = messageObj.optString("content")
                        val createdAt = messageObj.optString("created_at", null)
                        val fetchedMessageId = messageObj.optInt("id", -1).takeIf { it != -1 }
                        
                        val completeMessage = ChatMessage(
                            content, role, createdAt, null, false, fetchedMessageId
                        )
                        
                        newMessages.add(completeMessage)
                        println("ChatRepository: Fetched new complete message $messageId: $role - ${content.take(50)}...")
                        messageId++
                    }
                }
            } catch (e: Exception) {
                println("ChatRepository: Exception fetching message $messageId: ${e.message}")
                shouldContinue = false
            }
        }
        
        // If we found new messages, add them to the conversation and update the progressive store
        if (newMessages.isNotEmpty()) {
            val updatedMessages = currentMessages.toMutableList()
            updatedMessages.addAll(newMessages)
            
            // Sort by created_at to ensure proper order
            updatedMessages.sortBy { it.createdAt }
            
            withContext(Dispatchers.Main) {
                _messages.postValue(ArrayList(updatedMessages))
                ChatHistory.update(currentIndex, updatedMessages)
                
                // Update progressive message store
                updateMessageStore(conversationId, updatedMessages)
                
                println("ChatRepository: Added ${newMessages.size} new complete messages after chat")
            }
        }
    }
    
    /**
     * Update the progressive message store with new/updated messages
     */
    private fun updateMessageStore(conversationId: Int, messages: MutableList<ChatMessage>) {
        // Deduplicate messages by messageId, preferring messages with messageId over those without
        val deduplicatedMessages = mutableListOf<ChatMessage>()
        val seenMessageIds = mutableSetOf<Int>()
        val seenContentHashes = mutableSetOf<String>()
        
        for (message in messages) {
            var isDuplicate = false
            
            // Check for messageId duplicates first (most reliable)
            message.messageId?.let { id ->
                if (seenMessageIds.contains(id)) {
                    isDuplicate = true
                } else {
                    seenMessageIds.add(id)
                }
            }
            
            // If no messageId, check content + timestamp + role for duplicates
            if (!isDuplicate && message.messageId == null) {
                val contentHash = "${message.text}_${message.role}_${message.createdAt}"
                if (seenContentHashes.contains(contentHash)) {
                    isDuplicate = true
                } else {
                    seenContentHashes.add(contentHash)
                }
            }
            
            if (!isDuplicate) {
                deduplicatedMessages.add(message)
            } else {
                println("ChatRepository: Skipped duplicate message: ${message.messageId ?: "no-id"} - ${message.text.take(30)}...")
            }
        }
        
        // Update conversation messages with deduplicated list
        conversationMessages[conversationId] = deduplicatedMessages.toMutableList()
        
        // Update global message ID mapping and track highest ID
        for (message in deduplicatedMessages) {
            message.messageId?.let { id ->
                messageIdMap[id] = message
                if (id > highestKnownMessageId) {
                    highestKnownMessageId = id
                }
            }
        }
        
        val duplicateCount = messages.size - deduplicatedMessages.size
        println("ChatRepository: Updated message store for conversation $conversationId with ${deduplicatedMessages.size} messages (removed $duplicateCount duplicates, highest ID: $highestKnownMessageId)")
    }
    
    /**
     * Update the UI with new messages smoothly (for MainActivity to control timing)
     */
    fun updateMessagesSmooth(messages: MutableList<ChatMessage>) {
        _messages.postValue(ArrayList(messages))
    }

    /**
     * Load older messages smoothly in background without immediate UI update
     * Returns the updated message list for smooth UI handling, or null if no messages
     */
    fun loadOlderMessagesSmooth(callback: (MutableList<ChatMessage>?) -> Unit) {
        // Prevent multiple simultaneous pagination requests
        if (isLoadingOlderMessages) {
            callback(null)
            return
        }
        
        val conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
            ChatHistory.getConversationId(currentIndex)
        } else null
        
        if (conversationId == null) {
            callback(null)
            return
        }
        
        isLoadingOlderMessages = true
        
        scope.launch {
            try {
                val currentMessages = _messages.value ?: mutableListOf()
                val storedMessages = getStoredMessages(conversationId)
                
                // Check if we already have older messages in store
                if (storedMessages.size > currentMessages.size) {
                    println("ChatRepository: Found ${storedMessages.size - currentMessages.size} older messages in store")
                    // Return stored messages without API call
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(storedMessages)
                    }
                    return@launch
                }
                
                // Calculate offset for fetching older messages (working backwards from what we have)
                // We need to find the earliest message ID we have and fetch messages before it
                val currentMessageIds = currentMessages.mapNotNull { it.messageId }
                val earliestMessageId = currentMessageIds.minOrNull()
                
                val totalMessages = getTotalMessageCount(conversationId)
                val currentMessageCount = currentMessages.size
                
                // Calculate how many messages we should skip from the beginning to get older messages
                // We want to fetch messages that come before our current earliest message
                val offset = maxOf(0, totalMessages - currentMessageCount - 5)
                
                // Check if this offset has already been fetched
                if (isOffsetFetched(conversationId, offset)) {
                    println("ChatRepository: Offset $offset already fetched for conversation $conversationId, skipping API call")
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(null)
                    }
                    return@launch
                }
                
                println("ChatRepository: Loading older messages - offset: $offset, currentCount: $currentMessageCount, totalMessages: $totalMessages")
                
                // Fetch older messages using calculated offset
                val olderMessages = ChatHistory.fetchConversationById(conversationId, limit = 5, offset = offset)
                println("ChatRepository: Fetched ${olderMessages?.size ?: 0} older messages from server for smooth update")
                
                if (olderMessages != null && olderMessages.isNotEmpty()) {
                    // Mark this offset as fetched
                    markOffsetFetched(conversationId, offset)
                    
                    // With new pagination system, older messages come in chronological order
                    // Prepend them to current messages to maintain chronological order
                    val updatedMessages = mutableListOf<ChatMessage>()
                    updatedMessages.addAll(olderMessages)
                    updatedMessages.addAll(currentMessages)
                    
                    // Messages should already be in chronological order from backend
                    updatedMessages.sortBy { it.createdAt }
                    
                    // Update the total messages fetched counter to reflect actual message count
                    totalMessagesFetched = updatedMessages.size
                    println("ChatRepository: Updated totalMessagesFetched to: $totalMessagesFetched")
                    
                    // Update local storage and message store
                    ChatHistory.update(currentIndex, updatedMessages)
                    updateMessageStore(conversationId, updatedMessages)
                    
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(updatedMessages)
                    }
                } else {
                    // No messages returned - mark offset as fetched to avoid future requests
                    markOffsetFetched(conversationId, offset)
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(null)
                    }
                }
            } catch (e: Exception) {
                println("ChatRepository: Error loading older messages smoothly: ${e.message}")
                withContext(Dispatchers.Main) {
                    isLoadingOlderMessages = false
                    callback(null)
                }
            }
        }
    }
    
    /**
     * Load older messages for scroll-up pagination
     * Returns true if more messages were loaded, false if none available
     */
    fun loadOlderMessages(callback: (Boolean) -> Unit) {
        // Prevent multiple simultaneous pagination requests
        if (isLoadingOlderMessages) {
            callback(false)
            return
        }
        
        val conversationId = if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
            ChatHistory.getConversationId(currentIndex)
        } else null
        
        if (conversationId == null) {
            callback(false)
            return
        }
        
        isLoadingOlderMessages = true
        
        scope.launch {
            try {
                val currentMessages = _messages.value ?: mutableListOf()
                
                // Calculate offset for fetching older messages (working backwards from what we have)
                val currentMessageIds = currentMessages.mapNotNull { it.messageId }
                val earliestMessageId = currentMessageIds.minOrNull()
                
                val totalMessages = getTotalMessageCount(conversationId)
                val currentMessageCount = currentMessages.size
                
                // Calculate how many messages we should skip from the beginning to get older messages
                // We want to fetch messages that come before our current earliest message
                val offset = maxOf(0, totalMessages - currentMessageCount - 5)
                
                // Check if this offset has already been fetched
                if (isOffsetFetched(conversationId, offset)) {
                    println("ChatRepository: Offset $offset already fetched for conversation $conversationId, skipping API call")
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(false)
                    }
                    return@launch
                }
                
                println("ChatRepository: Loading older messages - offset: $offset, currentCount: $currentMessageCount, totalMessages: $totalMessages")
                
                // Fetch older messages using calculated offset
                val olderMessages = ChatHistory.fetchConversationById(conversationId, limit = 5, offset = offset)
                println("ChatRepository: Fetched ${olderMessages?.size ?: 0} older messages")
                
                if (olderMessages != null && olderMessages.isNotEmpty()) {
                    // Mark this offset as fetched
                    markOffsetFetched(conversationId, offset)
                    
                    // With new pagination system, older messages come in chronological order
                    // Prepend them to current messages to maintain chronological order
                    val updatedMessages = mutableListOf<ChatMessage>()
                    updatedMessages.addAll(olderMessages)
                    updatedMessages.addAll(currentMessages)
                    
                    // Messages should already be in chronological order from backend
                    updatedMessages.sortBy { it.createdAt }
                    
                    // Update the total messages fetched counter to reflect actual message count
                    totalMessagesFetched = updatedMessages.size
                    println("ChatRepository: Updated totalMessagesFetched to: $totalMessagesFetched")
                    
                    // Update local storage and UI
                    ChatHistory.update(currentIndex, updatedMessages)
                    _messages.postValue(ArrayList(updatedMessages))
                    
                    withContext(Dispatchers.Main) {
                        isLoadingOlderMessages = false
                        callback(true)
                    }
                } else {
                    // No messages returned - mark offset as fetched to avoid future requests
                    markOffsetFetched(conversationId, offset)
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
                ChatHistory.fetchFromServer()
                if (ChatHistory.size > 0) {
                    // Start with the newest conversation (last index)
                    currentIndex = ChatHistory.size - 1
                    
                    // Check message store first for initial conversation
                    val conversationId = ChatHistory.getConversationId(currentIndex)
                    if (conversationId != null) {
                        val storedMessages = getStoredMessages(conversationId)
                        if (storedMessages.isNotEmpty()) {
                            println("ChatRepository: Found ${storedMessages.size} stored messages for initial conversation")
                            totalMessagesFetched = storedMessages.size
                            _messages.postValue(ArrayList(storedMessages))
                            return@launch
                        }
                    }
                    
                    // Store miss - load only recent messages for faster initial display
                    val initialMessages = ChatHistory.getRecentMessages(currentIndex, initialLimit = 5)
                    totalMessagesFetched = initialMessages.size // Initialize counter with initial load
                    
                    // Update message store with initial messages
                    if (conversationId != null && initialMessages.isNotEmpty()) {
                        updateMessageStore(conversationId, initialMessages)
                        // Mark the most recent messages offset as fetched
                        val totalMessages = getTotalMessageCount(conversationId)
                        val recentOffset = maxOf(0, totalMessages - initialMessages.size)
                        markOffsetFetched(conversationId, recentOffset)
                    }
                    
                    _messages.postValue(ArrayList(initialMessages))
                    println("ChatRepository: Initialized totalMessagesFetched to: $totalMessagesFetched")
                    
                    // Removed auto-polling - messages load on demand
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
                
                // Refresh current conversation messages with recent messages only
                if (ChatHistory.size > 0) {
                    val conversationMessages = ChatHistory.getRecentMessages(currentIndex, initialLimit = 5)
                    totalMessagesFetched = conversationMessages.size // Reset counter after refresh
                    println("ChatRepository: Refreshed conversation has ${conversationMessages.size} recent messages, totalFetched: $totalMessagesFetched")
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
        
        // Check connection status before sending
        if (connected.value != true) {
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
                        
                        // Update message store with new messages after each update
                        val activeConversationId = ChatHistory.getConversationId(currentIndex)
                        if (activeConversationId != null) {
                            updateMessageStore(activeConversationId, list)
                        }
                    }
                }
                
                // After streaming finishes, fetch any new complete messages
                println("ChatRepository: Streaming finished, fetching new complete messages")
                try {
                    fetchNewCompleteMessages()
                } catch (e: Exception) {
                    println("ChatRepository: Failed to fetch new complete messages: ${e.message}")
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
        // Removed auto-polling - messages load on demand
    }

    fun switchConversation(index: Int) {
        if (index == currentIndex || index < 0 || index >= ChatHistory.size) {
            println("ChatRepository: Cannot switch conversation - index=$index, current=$currentIndex, size=${ChatHistory.size}")
            return
        }
        
        println("ChatRepository: Switching from conversation $currentIndex to $index")
        
        // Reset processing flag and message counter when switching conversations
        isProcessing = false
        totalMessagesFetched = 0
        
        // Save current conversation to message store before switching
        val currentConversationId = ChatHistory.getConversationId(currentIndex)
        if (currentConversationId != null) {
            val currentMessages = _messages.value ?: mutableListOf()
            updateMessageStore(currentConversationId, currentMessages)
        }
        ChatHistory.update(currentIndex, _messages.value ?: mutableListOf())
        currentIndex = index
        
        // Load conversation messages efficiently - check message store first
        scope.launch {
            try {
                val newConversationId = ChatHistory.getConversationId(index)
                if (newConversationId != null) {
                    val storedMessages = getStoredMessages(newConversationId)
                    if (storedMessages.isNotEmpty()) {
                        println("ChatRepository: Found ${storedMessages.size} stored messages for conversation $index")
                        totalMessagesFetched = storedMessages.size
                        _messages.postValue(ArrayList(storedMessages))
                        return@launch
                    }
                }
                
                // Store miss - fetch from server
                val conversationMessages = ChatHistory.getRecentMessages(index, initialLimit = 5)
                totalMessagesFetched = conversationMessages.size // Reset counter for new conversation
                println("ChatRepository: Loading ${conversationMessages.size} recent messages for conversation $index, totalFetched: $totalMessagesFetched")
                
                // Update message store with fetched messages
                if (newConversationId != null && conversationMessages.isNotEmpty()) {
                    updateMessageStore(newConversationId, conversationMessages)
                    // Mark the most recent messages offset as fetched
                    val totalMessages = getTotalMessageCount(newConversationId)
                    val recentOffset = maxOf(0, totalMessages - conversationMessages.size)
                    markOffsetFetched(newConversationId, recentOffset)
                }
                
                _messages.postValue(ArrayList(conversationMessages))
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
                // Clear message store for the conversation being deleted
                val deletedConversationId = ChatHistory.getConversationId(index)
                if (deletedConversationId != null) {
                    conversationMessages.remove(deletedConversationId)
                    // Also remove individual messages from the global map
                    messageIdMap.values.removeAll { it.conversationId == deletedConversationId }
                    // Clear offset tracking for the deleted conversation
                    clearOffsetTracking(deletedConversationId)
                    println("ChatRepository: Cleared message store for deleted conversation $deletedConversationId")
                }
                
                val success = ChatHistory.deleteConversation(index)
                
                // If we deleted the current conversation, switch to another one
                if (index == currentIndex) {
                    val newSize = ChatHistory.size
                    if (newSize > 0) {
                        // Switch to the previous conversation or the first one
                        val newIndex = if (index > 0) index - 1 else 0
                        currentIndex = newIndex
                        
                        // Check message store first for the new conversation
                        val newConversationId = ChatHistory.getConversationId(newIndex)
                        if (newConversationId != null) {
                            val storedMessages = getStoredMessages(newConversationId)
                            if (storedMessages.isNotEmpty()) {
                                println("ChatRepository: Found ${storedMessages.size} stored messages for conversation $newIndex after deletion")
                                totalMessagesFetched = storedMessages.size
                                _messages.postValue(ArrayList(storedMessages))
                                withContext(Dispatchers.Main) {
                                    onComplete(success)
                                }
                                return@launch
                            }
                        }
                        
                        // Store miss - fetch from server
                        val conversationMessages = ChatHistory.getRecentMessages(newIndex, initialLimit = 5)
                        totalMessagesFetched = conversationMessages.size // Reset counter for new conversation
                        
                        // Update message store with fetched messages
                        if (newConversationId != null && conversationMessages.isNotEmpty()) {
                            updateMessageStore(newConversationId, conversationMessages)
                        }
                        
                        _messages.postValue(ArrayList(conversationMessages))
                        // Removed auto-polling - messages load on demand
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

    // Removed polling mechanism - app now uses manual refresh only

    fun destroy() {
        agent.destroy()
        player.stop()
        player.release()
    }
}
