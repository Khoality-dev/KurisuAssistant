package com.kurisu.assistant.ui.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.FrameInfo
import com.kurisu.assistant.data.model.Message
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    onBack: () -> Unit,
    onNavigateToSettings: () -> Unit,
    onNavigateToCharacter: (agentId: Int) -> Unit,
    viewModel: ChatViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val streaming by viewModel.streamingState.collectAsState()
    val ttsState by viewModel.ttsState.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val coreServiceState by viewModel.coreServiceState.collectAsState()

    val listState = rememberLazyListState()

    // Combine persisted + streaming messages
    val allMessages: List<Message> = state.messages + streaming.streamingMessages

    // Auto-scroll to bottom on new messages
    LaunchedEffect(allMessages.size) {
        if (allMessages.isNotEmpty()) {
            listState.animateScrollToItem(allMessages.size - 1)
        }
    }

    // Load more when scrolling to top
    val firstVisibleItem by remember { derivedStateOf { listState.firstVisibleItemIndex } }
    LaunchedEffect(firstVisibleItem) {
        if (firstVisibleItem <= 1 && state.hasMore && !state.isLoadingMore) {
            viewModel.loadMoreMessages()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(
                            text = state.selectedAgent?.name ?: "Chat",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        if (streaming.typingAgentName != null) {
                            Text(
                                text = "${streaming.typingAgentName} is typing...",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else if (state.selectedAgent?.modelName != null) {
                            Text(
                                text = state.selectedAgent!!.modelName!!,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                actions = {
                    // Character button (if agent has character config)
                    if (state.selectedAgent?.characterConfig != null) {
                        IconButton(onClick = { onNavigateToCharacter(state.selectedAgent!!.id) }) {
                            Icon(Icons.Default.Person, contentDescription = "Character")
                        }
                    }
                    // Delete conversation
                    if (state.conversationId != null) {
                        IconButton(onClick = viewModel::deleteConversation) {
                            Icon(Icons.Default.Delete, contentDescription = "Delete conversation")
                        }
                    }
                    // Settings
                    IconButton(onClick = onNavigateToSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            // Error banner
            streaming.streamError?.let { error ->
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    shape = MaterialTheme.shapes.small,
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = error,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        IconButton(onClick = { viewModel.streamProcessor.clearError() }) {
                            Icon(Icons.Default.Close, contentDescription = "Dismiss")
                        }
                    }
                }
            }

            // Messages list
            if (allMessages.isEmpty() && !streaming.isStreaming) {
                Box(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Send a message to start a conversation",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    state = listState,
                    contentPadding = PaddingValues(vertical = 8.dp),
                ) {
                    // Loading more indicator
                    if (state.isLoadingMore) {
                        item {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(24.dp))
                            }
                        }
                    }

                    allMessages.forEachIndexed { index, message ->
                        // Frame separator when frame_id changes
                        val prevFrameId = if (index > 0) allMessages[index - 1].frameId else null
                        val curFrameId = message.frameId
                        if (curFrameId != null && curFrameId != prevFrameId) {
                            val frame = state.frames[curFrameId.toString()]
                            item(key = "frame_sep_$curFrameId") {
                                FrameSeparator(frame = frame)
                            }
                        }

                        item(
                            key = message.id ?: "${message.role}_${message.content.hashCode()}_$index",
                        ) {
                            MessageBubble(
                                message = message,
                                baseUrl = state.baseUrl,
                                onDelete = if (message.id != null) {
                                    { msgId -> viewModel.deleteMessage(msgId) }
                                } else {
                                    null
                                },
                                onResend = if (message.id != null && message.role == "user") {
                                    { msgId, text -> viewModel.resendMessage(msgId, text) }
                                } else {
                                    null
                                },
                                onGetRawData = if (message.hasRawData == true) {
                                    { msgId -> viewModel.getMessageRaw(msgId) }
                                } else {
                                    null
                                },
                            )
                        }
                    }

                    // Typing indicator
                    if (streaming.isStreaming && streaming.streamingMessages.isEmpty()) {
                        item {
                            Box(
                                modifier = Modifier.fillMaxWidth().padding(16.dp),
                                contentAlignment = Alignment.CenterStart,
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                }
            }

            // Divider
            HorizontalDivider()

            // Chat input
            ChatInput(
                text = state.inputText,
                onTextChange = viewModel::setInputText,
                onSend = { viewModel.sendMessage() },
                onCancel = viewModel::cancelStream,
                onImageSelected = viewModel::addImage,
                onRemoveImage = viewModel::removeImage,
                selectedImages = state.selectedImages,
                isStreaming = streaming.isStreaming,
                isMicActive = false,
                isInteractionMode = voiceState.isInteractionMode,
                lastTranscript = coreServiceState.lastTranscript,
                onMicToggle = null,
            )
        }
    }
}

@Composable
private fun FrameSeparator(frame: FrameInfo?) {
    val dateStr = frame?.createdAt?.let {
        try {
            val instant = Instant.parse(it)
            val local = instant.atZone(ZoneId.systemDefault())
            local.format(DateTimeFormatter.ofPattern("MMM d, HH:mm"))
        } catch (_: Exception) {
            "New session"
        }
    } ?: "New session"

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(modifier = Modifier.weight(1f))
        Text(
            text = dateStr,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 12.dp),
            textAlign = TextAlign.Center,
        )
        HorizontalDivider(modifier = Modifier.weight(1f))
    }
}
