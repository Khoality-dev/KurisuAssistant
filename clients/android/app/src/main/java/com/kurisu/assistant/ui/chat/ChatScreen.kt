package com.kurisu.assistant.ui.chat

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Face
import androidx.compose.material.icons.outlined.Hearing
import androidx.compose.material.icons.outlined.HearingDisabled
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.ui.character.CharacterSheet
import com.kurisu.assistant.ui.theme.KurisuTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    /** Opens the app drawer, which is hosted above this screen by the nav graph. */
    onOpenMenu: () -> Unit,
    /** "Manage personas" in the persona sheet. */
    onNavigateToPersonas: () -> Unit,
    viewModel: ChatViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val streaming by viewModel.streamingState.collectAsState()
    val ttsState by viewModel.ttsState.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val coreServiceState by viewModel.coreServiceState.collectAsState()

    val listState = rememberLazyListState()

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

    // Slash command modals
    state.modal?.let { modal ->
        when (modal) {
            is ChatModal.ResumePicker -> ResumePickerDialog(
                modal = modal,
                onDismiss = viewModel::dismissModal,
                onPick = viewModel::resumeConversation,
            )
            is ChatModal.PersonaPicker -> PersonaSheet(
                modal = modal,
                defaultPersonaName = state.defaultPersonaName,
                currentPersonaId = state.persona?.id,
                baseUrl = state.baseUrl,
                onDismiss = viewModel::dismissModal,
                onPick = viewModel::switchPersona,
                onManagePersonas = {
                    viewModel.dismissModal()
                    onNavigateToPersonas()
                },
            )
            is ChatModal.ContextDialog -> ContextInfoDialog(
                modal = modal,
                onDismiss = viewModel::dismissModal,
            )
        }
    }

    // Transient command feedback (auto-dismissed)
    state.commandFeedback?.let { msg ->
        LaunchedEffect(msg) {
            kotlinx.coroutines.delay(2200)
            viewModel.clearCommandFeedback()
        }
    }

    // Tool approval — a sheet, not a dialog: the args are the whole decision and
    // an AlertDialog truncated them.
    state.pendingApproval?.let { approval ->
        ToolApprovalSheet(
            approval = approval,
            onApprove = viewModel::approveToolCall,
            onDeny = viewModel::denyToolCall,
        )
    }

    // Delete confirmation. Deletion used to be one unguarded tap.
    if (state.deleteConfirmOpen) {
        AlertDialog(
            onDismissRequest = viewModel::cancelDeleteConversation,
            title = { Text("Delete this conversation?") },
            text = {
                Text("The transcript and its tool results go with it. The assistant keeps its memory.")
            },
            confirmButton = {
                TextButton(onClick = viewModel::confirmDeleteConversation) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelDeleteConversation) { Text("Cancel") }
            },
        )
    }

    // The live character, over the transcript rather than instead of it.
    var showCharacter by remember { mutableStateOf(false) }
    if (showCharacter) {
        CharacterSheet(
            personaId = state.persona?.id,
            onDismiss = { showCharacter = false },
        )
    }

    // Combine persisted + streaming messages
    val allMessages: List<Message> = state.messages + streaming.streamingMessages

    // Auto-scroll to bottom on new messages — only if user is already near the bottom.
    // Matches desktop's <100px tolerance: respects manual scroll-up to read history.
    val isNearBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val total = info.totalItemsCount
            if (total == 0) return@derivedStateOf true
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            lastVisible >= total - 2
        }
    }
    LaunchedEffect(allMessages.size, streaming.streamingMessages.size) {
        if (allMessages.isNotEmpty() && isNearBottom) {
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

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Default.Menu, contentDescription = "Menu")
                    }
                },
                title = {
                    // The header names WHO is answering, not "Chat". Tapping it
                    // is the per-conversation persona switch.
                    Column(
                        modifier = Modifier
                            .clip(MaterialTheme.shapes.small)
                            .clickable(onClick = viewModel::openPersonaSheet)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = state.persona?.name ?: "Assistant",
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                            Icon(
                                Icons.Default.ExpandMore,
                                contentDescription = "Switch persona",
                                modifier = Modifier.size(18.dp).padding(start = 2.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        val isTyping = streaming.typingAgentName != null || streaming.isStreaming
                        val micLabel = when {
                            voiceState.isInteractionMode -> "voice"
                            coreServiceState.isRecording -> "listening"
                            else -> "off"
                        }
                        Text(
                            text = if (isTyping) {
                                "${state.persona?.name ?: "Assistant"} is typing…"
                            } else {
                                listOfNotNull(
                                    state.assistant?.modelName?.takeIf { it.isNotBlank() },
                                    "mic $micLabel",
                                ).joinToString(" · ")
                            },
                            style = KurisuTheme.extraTypography.metadataSmall,
                            color = if (isTyping) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showCharacter = true }) {
                        Icon(Icons.Outlined.Face, contentDescription = "Live character")
                    }

                    var overflowOpen by remember { mutableStateOf(false) }
                    IconButton(onClick = { overflowOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(
                        expanded = overflowOpen,
                        onDismissRequest = { overflowOpen = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("New conversation") },
                            leadingIcon = { Icon(Icons.Outlined.AddComment, contentDescription = null) },
                            onClick = {
                                overflowOpen = false
                                viewModel.clearCurrentConversation()
                            },
                        )
                        DropdownMenuItem(
                            text = {
                                Text(if (state.alwaysListen) "Always listen on" else "Always listen off")
                            },
                            leadingIcon = {
                                Icon(
                                    if (state.alwaysListen) Icons.Outlined.Hearing else Icons.Outlined.HearingDisabled,
                                    contentDescription = null,
                                )
                            },
                            onClick = {
                                overflowOpen = false
                                val nowOn = viewModel.toggleAlwaysListen()
                                if (nowOn != coreServiceState.isRecording) {
                                    CoreService.toggleRecording(context)
                                }
                            },
                        )
                        if (state.conversationId != null) {
                            DropdownMenuItem(
                                text = { Text("Compact context") },
                                leadingIcon = { Icon(Icons.Outlined.Compress, contentDescription = null) },
                                onClick = {
                                    overflowOpen = false
                                    viewModel.compactContext()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Context breakdown") },
                                leadingIcon = { Icon(Icons.Outlined.DataObject, contentDescription = null) },
                                onClick = {
                                    overflowOpen = false
                                    viewModel.openContextDialog()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Reload from server") },
                                leadingIcon = { Icon(Icons.Outlined.Refresh, contentDescription = null) },
                                onClick = {
                                    overflowOpen = false
                                    viewModel.refreshConversation()
                                },
                            )
                            DropdownMenuItem(
                                text = {
                                    Text("Delete conversation", color = MaterialTheme.colorScheme.error)
                                },
                                leadingIcon = {
                                    Icon(
                                        Icons.Outlined.DeleteOutline,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error,
                                    )
                                },
                                onClick = {
                                    overflowOpen = false
                                    viewModel.requestDeleteConversation()
                                },
                            )
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
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    PersonaAvatar(
                        name = state.persona?.name,
                        avatarUrl = state.persona?.avatarUuid?.let { "${state.baseUrl}/images/$it" },
                        size = 56.dp,
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "Send a message to start",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    val hint = remember(state.assistant) {
                        val a = state.assistant
                        listOfNotNull(
                            a?.modelName?.takeIf { it.isNotBlank() },
                            a?.availableTools?.let { tools -> "${tools.size} tools" },
                            a?.triggerWord?.takeIf { it.isNotBlank() }?.let { "or say \u201C$it\u201D" },
                        ).joinToString(" · ")
                    }
                    if (hint.isNotEmpty()) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = hint,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
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

            // Command feedback toast
            state.commandFeedback?.let { msg ->
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(
                        text = msg,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
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
                isInteractionMode = voiceState.isInteractionMode,
                voiceIdleDeadlineMs = voiceState.idleDeadlineMs,
                onStopVoice = viewModel::stopVoiceMode,
            )
        }
    }
}

@Composable
private fun ResumePickerDialog(
    modal: ChatModal.ResumePicker,
    onDismiss: () -> Unit,
    onPick: (Int) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Resume conversation") },
        text = {
            when {
                modal.loading -> Box(
                    modifier = Modifier.fillMaxWidth().padding(24.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(modifier = Modifier.size(28.dp)) }
                modal.conversations.isEmpty() -> Text(
                    "No previous conversations.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> androidx.compose.foundation.lazy.LazyColumn(
                    modifier = Modifier.heightIn(max = 360.dp),
                ) {
                    items(modal.conversations.size) { idx ->
                        val conv = modal.conversations[idx]
                        val title = conv.title.ifBlank { "Conversation #${conv.id}" }
                        val preview = conv.lastMessage?.content?.take(80) ?: ""
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(conv.id) }
                                .padding(horizontal = 4.dp, vertical = 10.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = title,
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                )
                                if (preview.isNotEmpty()) {
                                    Text(
                                        text = preview,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                        if (idx < modal.conversations.lastIndex) HorizontalDivider()
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * The per-conversation persona switch.
 *
 * The subtitle is the whole contract: this conversation moves, the assistant's
 * default does not. Without it the sheet reads like a global setting and every
 * future chat looks changed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PersonaSheet(
    modal: ChatModal.PersonaPicker,
    defaultPersonaName: String?,
    currentPersonaId: Int?,
    baseUrl: String,
    onDismiss: () -> Unit,
    onPick: (Persona) -> Unit,
    onManagePersonas: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text("Persona", style = MaterialTheme.typography.titleLarge)
            Text(
                text = if (defaultPersonaName != null) {
                    "This conversation only — the default stays $defaultPersonaName"
                } else {
                    "This conversation only — the assistant's default is unchanged"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when {
            modal.loading -> Box(
                modifier = Modifier.fillMaxWidth().padding(32.dp),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator(modifier = Modifier.size(28.dp)) }

            modal.personas.isEmpty() -> Text(
                text = "No personas yet. Create one to choose who answers.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
            )

            else -> modal.personas.forEach { persona ->
                val isCurrent = persona.id == currentPersonaId
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(13.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { if (isCurrent) onDismiss() else onPick(persona) }
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    PersonaAvatar(
                        name = persona.name,
                        avatarUrl = persona.avatarUuid?.let { "$baseUrl/images/$it" },
                        size = 40.dp,
                        fontSize = 13.sp,
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = persona.name,
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                        val meta = personaMetaLine(persona)
                        if (meta.isNotEmpty()) {
                            Text(
                                text = meta,
                                style = KurisuTheme.extraTypography.metadataSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (isCurrent) {
                        Icon(
                            Icons.Default.Check,
                            contentDescription = "Answering this conversation",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        }

        HorizontalDivider(modifier = Modifier.padding(top = 8.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onManagePersonas)
                .padding(horizontal = 20.dp, vertical = 14.dp),
        ) {
            Icon(Icons.Outlined.Tune, contentDescription = null)
            Text("Manage personas", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Icon(
                Icons.Outlined.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

/** `kurisu_neutral.wav · character`, or "no voice" when there is nothing to say. */
private fun personaMetaLine(persona: Persona): String = listOfNotNull(
    persona.voiceReference?.takeIf { it.isNotBlank() } ?: "no voice",
    if (persona.characterConfig != null) "character" else null,
).joinToString(" · ")

/**
 * Tool approval.
 *
 * The risk chip is drawn only when the server actually sent a level. The backend
 * never populates `risk_level` today (see `websocket/events.py`), so drawing it
 * unconditionally — as the design does — would put a permanent "Risk: " label
 * with nothing after it on every approval.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ToolApprovalSheet(
    approval: ToolApprovalRequestEvent,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDeny) {
        Column(
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(
                        Icons.Outlined.Shield,
                        contentDescription = null,
                        modifier = Modifier.size(19.dp),
                        tint = KurisuTheme.extraColors.riskMediumContent,
                    )
                    Text(
                        text = "Tool approval",
                        style = KurisuTheme.extraTypography.metadataSmall,
                        color = KurisuTheme.extraColors.riskMediumContent,
                    )
                    Spacer(Modifier.weight(1f))
                    if (approval.riskLevel.isNotBlank()) {
                        val risk = KurisuTheme.extraColors
                        val (chipBg, chipFg) = when (approval.riskLevel) {
                            "high" -> risk.riskHighBackground to risk.riskHighContent
                            "medium" -> risk.riskMediumBackground to risk.riskMediumContent
                            else -> risk.riskLowBackground to risk.riskLowContent
                        }
                        Surface(color = chipBg, contentColor = chipFg, shape = MaterialTheme.shapes.small) {
                            Text(
                                text = "Risk: ${approval.riskLevel}",
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }

                Text(
                    text = approval.toolName,
                    style = KurisuTheme.extraTypography.metadata.copy(fontSize = 19.sp),
                )
                if (approval.description.isNotBlank()) {
                    Text(
                        text = approval.description,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            val argsStr = approval.toolArgs.toString()
            if (argsStr != "{}" && argsStr.isNotBlank()) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = argsStr,
                        modifier = Modifier
                            .padding(14.dp)
                            .heightIn(max = 220.dp)
                            .verticalScroll(rememberScrollState()),
                        style = KurisuTheme.extraTypography.metadata,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                OutlinedButton(
                    onClick = onDeny,
                    modifier = Modifier.weight(1f).height(48.dp),
                ) { Text("Deny") }
                Button(
                    onClick = onApprove,
                    modifier = Modifier.weight(1.4f).height(48.dp),
                ) { Text("Approve") }
            }
        }
    }
}

@Composable
private fun ContextInfoDialog(
    modal: ChatModal.ContextDialog,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Context") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "Conversation: ${modal.conversationId ?: "—"}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    "Tokens used: ${modal.tokenCount ?: "—"}",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (modal.compacting) {
                    Text(
                        "Compaction in progress...",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else if (modal.compactedUpToId > 0) {
                    Text(
                        "Compacted up to message #${modal.compactedUpToId}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (modal.compactedContext.isNotBlank()) {
                    HorizontalDivider()
                    Text(
                        text = modal.compactedContext,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = com.kurisu.assistant.ui.theme.JetBrainsMono,
                            fontSize = 11.sp,
                        ),
                        modifier = Modifier
                            .heightIn(max = 200.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
