package com.kurisu.assistant.ui.chat

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.FrameInfo
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.ui.update.UpdateDialog
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    onNavigateToAccount: () -> Unit,
    onNavigateToTtsAsr: () -> Unit,
    onNavigateToAppearance: () -> Unit,
    onNavigateToPersonas: () -> Unit,
    onNavigateToAgents: () -> Unit,
    onNavigateToToolsMcp: () -> Unit,
    onNavigateToSkills: () -> Unit,
    onLogout: () -> Unit,
    viewModel: ChatViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val streaming by viewModel.streamingState.collectAsState()
    val ttsState by viewModel.ttsState.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val coreServiceState by viewModel.coreServiceState.collectAsState()

    val listState = rememberLazyListState()
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // Request mic permission and auto-start CoreService
    val context = androidx.compose.ui.platform.LocalContext.current
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted && !coreServiceState.isServiceRunning) {
            CoreService.start(context)
        }
    }
    LaunchedEffect(Unit) {
        if (!coreServiceState.isServiceRunning) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // Logout confirmation dialog
    var showLogoutDialog by remember { mutableStateOf(false) }
    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = { Text("Logout") },
            text = { Text("Are you sure you want to logout?") },
            confirmButton = {
                TextButton(onClick = {
                    showLogoutDialog = false
                    viewModel.logout(onLogout)
                }) {
                    Text("Logout")
                }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutDialog = false }) {
                    Text("Cancel")
                }
            },
        )
    }

    // Tool approval dialog
    state.pendingApproval?.let { approval ->
        AlertDialog(
            onDismissRequest = { viewModel.denyToolCall() },
            title = { Text("Tool Approval") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = approval.toolName,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    if (approval.description.isNotBlank()) {
                        Text(
                            text = approval.description,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (approval.riskLevel.isNotBlank()) {
                        Surface(
                            color = when (approval.riskLevel) {
                                "high" -> MaterialTheme.colorScheme.errorContainer
                                "medium" -> MaterialTheme.colorScheme.tertiaryContainer
                                else -> MaterialTheme.colorScheme.surfaceVariant
                            },
                            shape = MaterialTheme.shapes.small,
                        ) {
                            Text(
                                text = "Risk: ${approval.riskLevel}",
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                    val argsStr = approval.toolArgs.toString()
                    if (argsStr != "{}" && argsStr.isNotBlank()) {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            shape = MaterialTheme.shapes.small,
                        ) {
                            Text(
                                text = argsStr,
                                modifier = Modifier.padding(8.dp),
                                style = MaterialTheme.typography.bodySmall.copy(
                                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                                    fontSize = 11.sp,
                                ),
                                maxLines = 10,
                            )
                        }
                    }
                }
            },
            confirmButton = {
                Button(onClick = { viewModel.approveToolCall() }) {
                    Text("Approve")
                }
            },
            dismissButton = {
                OutlinedButton(onClick = { viewModel.denyToolCall() }) {
                    Text("Deny")
                }
            },
        )
    }

    // Combine persisted + streaming messages
    val allMessages: List<Message> = state.messages + streaming.streamingMessages

    // Auto-scroll to bottom on new messages
    LaunchedEffect(allMessages.size) {
        if (allMessages.isNotEmpty()) {
            val lastIndex = listState.layoutInfo.totalItemsCount - 1
            if (lastIndex >= 0) {
                listState.animateScrollToItem(lastIndex)
            }
        }
    }

    // Load more when scrolling to top
    val firstVisibleItem by remember { derivedStateOf { listState.firstVisibleItemIndex } }
    LaunchedEffect(firstVisibleItem) {
        if (firstVisibleItem <= 1 && state.hasMore && !state.isLoadingMore) {
            viewModel.loadMoreMessages()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(modifier = Modifier.width(280.dp)) {
                Spacer(Modifier.height(16.dp))
                Text(
                    text = "Kurisu",
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.AccountCircle, contentDescription = null) },
                    label = { Text("Account") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToAccount() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.RecordVoiceOver, contentDescription = null) },
                    label = { Text("TTS & ASR") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToTtsAsr() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.Palette, contentDescription = null) },
                    label = { Text("Appearance") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToAppearance() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                HorizontalDivider(modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.Person, contentDescription = null) },
                    label = { Text("Personas") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToPersonas() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.SmartToy, contentDescription = null) },
                    label = { Text("Agents") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToAgents() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                HorizontalDivider(modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.Build, contentDescription = null) },
                    label = { Text("Tools & MCP") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToToolsMcp() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    icon = { Icon(Icons.Default.AutoFixHigh, contentDescription = null) },
                    label = { Text("Skills") },
                    selected = false,
                    onClick = { scope.launch { drawerState.close() }; onNavigateToSkills() },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Spacer(Modifier.weight(1f))
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                NavigationDrawerItem(
                    icon = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null) },
                    label = { Text("Logout") },
                    selected = false,
                    onClick = {
                        scope.launch { drawerState.close() }
                        showLogoutDialog = true
                    },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Spacer(Modifier.height(16.dp))
            }
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Default.Menu, contentDescription = "Menu")
                        }
                    },
                    title = {
                        Column {
                            Text(
                                text = "Chat",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            if (streaming.typingAgentName != null) {
                                Text(
                                    text = "${streaming.typingAgentName} is typing...",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    },
                    actions = {
                        if (state.conversationId != null) {
                            IconButton(onClick = viewModel::refreshConversation) {
                                Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                            }
                            IconButton(onClick = viewModel::deleteConversation) {
                                Icon(Icons.Default.Delete, contentDescription = "Clear conversation")
                            }
                        }
                    },
                )
            },
        ) { padding ->
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).imePadding(),
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

                        // Queued messages
                        streaming.queuedMessages.forEachIndexed { idx, queued ->
                            item(key = "queued_$idx") {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 4.dp),
                                    horizontalArrangement = Arrangement.End,
                                ) {
                                    Surface(
                                        modifier = Modifier
                                            .widthIn(max = 320.dp)
                                            .alpha(0.5f),
                                        color = MaterialTheme.colorScheme.surfaceVariant,
                                        shape = RoundedCornerShape(8.dp),
                                        border = BorderStroke(
                                            1.dp,
                                            MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                                        ),
                                    ) {
                                        Column(modifier = Modifier.padding(10.dp)) {
                                            Text(
                                                text = "Queued",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                                            )
                                            Spacer(Modifier.height(2.dp))
                                            Text(
                                                text = queued.text,
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = MaterialTheme.colorScheme.onSurface,
                                            )
                                        }
                                    }
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
