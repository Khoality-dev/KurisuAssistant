package com.kurisu.assistant.ui.chat

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.gestures.stopScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Face
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.ToolApprovalRequestEvent
import com.kurisu.assistant.data.model.WsErrorCodes
import com.kurisu.assistant.domain.character.CharacterConfigKind
import com.kurisu.assistant.domain.character.metaLabel
import com.kurisu.assistant.service.CoreService
import com.kurisu.assistant.ui.character.CharacterSheet
import com.kurisu.assistant.ui.theme.KurisuTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    /** Opens the app drawer, which is hosted above this screen by the nav graph. */
    onOpenMenu: () -> Unit,
    /** "Manage personas" in the persona sheet. */
    onNavigateToPersonas: () -> Unit,
    /** The voice bar's "Open Assistant": where the wake word is set (#341). */
    onNavigateToAssistant: () -> Unit = {},
    /** The new-conversation marker's "Chats": where the previous conversation is kept (#341). */
    onNavigateToChats: () -> Unit = {},
    viewModel: ChatViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val streaming by viewModel.streamingState.collectAsState()
    val ttsState by viewModel.ttsState.collectAsState()
    val voiceState by viewModel.voiceState.collectAsState()
    val coreServiceState by viewModel.coreServiceState.collectAsState()

    val listState = rememberLazyListState()

    // What the voice bar shows (#341), from voice mode, the mic and the reply.
    val voicePhase = com.kurisu.assistant.domain.voice.voiceBarPhase(
        com.kurisu.assistant.domain.voice.VoiceBarInput(
            problem = coreServiceState.micProblem,
            triggerWord = state.assistant?.triggerWord,
            interactionActive = voiceState.interactionActive,
            userTalking = coreServiceState.userTalking,
            transcribing = coreServiceState.isProcessingAsr,
            isStreaming = streaming.isStreaming,
            isSpeaking = ttsState.isQueueActive,
        ),
    )
    // Back from Android settings with mic access allowed: voice mode tries again.
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
        viewModel.onResume()
    }
    // Voice mode hides the keyboard: the voice bar stands in for the composer.
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    LaunchedEffect(voiceState.voiceMode) { if (voiceState.voiceMode) keyboard?.hide() }
    // Turning voice mode off says the mic is off (#341).
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(state.voiceOffNotice) {
        if (state.voiceOffNotice) {
            snackbarHostState.showSnackbar("Voice mode is off. The mic isn't listening.")
            viewModel.dismissVoiceOffNotice()
        }
    }

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
                selectedPersonaName = state.selectedPersonaName,
                currentPersonaId = state.persona?.id,
                baseUrl = state.baseUrl,
                onDismiss = viewModel::dismissModal,
                onPick = viewModel::switchPersona,
                onManagePersonas = {
                    viewModel.dismissModal()
                    onNavigateToPersonas()
                },
            )
            is ChatModal.ModelPicker -> ModelSheet(
                modal = modal,
                currentModelName = state.assistant?.modelName,
                currentProvider = state.assistant?.providerType,
                onDismiss = viewModel::dismissModal,
                onPick = viewModel::pickModel,
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

    // Where the transcript rests (#332). It follows its end: a conversation
    // opens on its latest messages, and a reply is followed as it grows. A
    // scroll the screen did not make — the user's drag or fling, TalkBack —
    // that leaves the end stops the following, so reading back is not undone
    // by the next token; coming back to the end, or sending, resumes it.
    var followLatest by remember { mutableStateOf(true) }
    // A fling still coasting from before is not the user leaving the end, and
    // would read as one: it is stopped first.
    suspend fun followFromHere() {
        try {
            listState.stopScroll()
            followLatest = true
        } catch (e: CancellationException) {
            // A finger still on the list outranks this, and decides.
            currentCoroutineContext().ensureActive()
        }
    }
    LaunchedEffect(state.conversationId) { followFromHere() }
    val sentCount = streaming.streamingMessages.count { it.role == "user" }
    LaunchedEffect(sentCount) { if (sentCount > 0) followFromHere() }
    LaunchedEffect(listState) {
        snapshotFlow { Triple(listState.canScrollForward, listState.isScrollInProgress, followLatest) }
            .collect { (endHidden, scrolling, follow) ->
                when {
                    !endHidden -> followLatest = true
                    // Never this screen's own scroll: that one is over before this reads.
                    scrolling -> followLatest = false
                    // Content grew, the list shrank under the keyboard, or a
                    // conversation opened: back to the end — the last item
                    // is the spacer below the last line, so a reply taller than
                    // the screen shows its end rather than its top.
                    follow -> {
                        // At a frame, never from wherever the change was
                        // delivered: that can be mid-layout, and a scroll from
                        // there re-enters the layout pass and throws.
                        withFrameNanos { }
                        if (followLatest && listState.canScrollForward && !listState.isScrollInProgress) try {
                            listState.scrollToItem(listState.layoutInfo.totalItemsCount - 1)
                        } catch (e: CancellationException) {
                            // The user's own scroll outranks this one, and decides.
                            currentCoroutineContext().ensureActive()
                        }
                    }
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
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Default.Menu, contentDescription = "Menu")
                    }
                },
                title = {
                    // The header names WHO is answering and WHAT it runs on, and
                    // each is its own tap. The persona is this conversation's —
                    // the sheet moves this thread only. The model is the
                    // assistant's — one for every persona, applied from the next
                    // message — so it is not on the Assistant page at all (#197).
                    Column(modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(MaterialTheme.shapes.small)
                                .clickable(onClick = viewModel::openPersonaSheet),
                        ) {
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
                        if (isTyping) {
                            Text(
                                text = "${state.persona?.name ?: "Assistant"} is typing…",
                                style = KurisuTheme.extraTypography.metadataSmall,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            )
                        } else {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .clip(MaterialTheme.shapes.small)
                                    .clickable(onClick = viewModel::openModelSheet),
                            ) {
                                Text(
                                    text = state.assistant?.modelName?.takeIf { it.isNotBlank() }
                                        ?: "No model",
                                    style = KurisuTheme.extraTypography.metadataSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Icon(
                                    Icons.Default.ExpandMore,
                                    contentDescription = "Change model",
                                    modifier = Modifier.size(14.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                if (voiceState.voiceMode) {
                                    Text(
                                        text = " · voice mode on",
                                        style = KurisuTheme.extraTypography.metadataSmall,
                                        color = if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFF60A5FA) else Color(0xFF0070DB),
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                },
                actions = {
                    // Voice mode (#341): the one control for the mic, in place of
                    // "Always listen" in the menu.
                    VoiceModeButton(
                        on = voiceState.voiceMode,
                        attention = voiceState.voiceMode && voicePhase.isProblem,
                        onToggle = { viewModel.setVoiceMode(!voiceState.voiceMode) },
                    )
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
            // Error banner. NO_MODEL_SELECTED is the one code that is not a fault:
            // a new account has no model chosen yet, so it reads as a setup step —
            // the calmer secondaryContainer, and a button that opens the model
            // sheet right here, with the refused message still in the box below
            // — rather than as something having gone wrong (#149, #197).
            streaming.streamError?.let { error ->
                val needsModel = streaming.streamErrorCode == WsErrorCodes.NO_MODEL_SELECTED
                Surface(
                    color = if (needsModel) {
                        MaterialTheme.colorScheme.secondaryContainer
                    } else {
                        MaterialTheme.colorScheme.errorContainer
                    },
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    shape = MaterialTheme.shapes.small,
                ) {
                    Row(
                        modifier = Modifier.padding(start = 12.dp, top = 12.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = error,
                            color = if (needsModel) {
                                MaterialTheme.colorScheme.onSecondaryContainer
                            } else {
                                MaterialTheme.colorScheme.onErrorContainer
                            },
                            // Capped like the conversations-list banner: the buttons
                            // beside it are unweighted, so at a large font scale an
                            // uncapped Text wraps to a few characters a line and the
                            // banner grows until it owns the screen.
                            maxLines = 3,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        if (needsModel) {
                            TextButton(onClick = {
                                viewModel.streamProcessor.clearError()
                                viewModel.openModelSheet()
                            }) {
                                Text("Choose a model")
                            }
                        }
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
                            // The wake word is heard only in voice mode (#341).
                            a?.triggerWord?.takeIf { it.isNotBlank() && voiceState.voiceMode }?.let { "or say \u201C$it\u201D" },
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

                    // An interaction's new conversation opens on a marker (#341).
                    val marker = state.interactionMarker
                    if (marker != null && state.showInteractionMarker) {
                        item(key = "interaction_marker") {
                            NewInteractionMarker(
                                wakeWord = state.assistant?.triggerWord,
                                atMs = marker.atMs,
                                hasPrevious = marker.previousConversationId != null,
                                onOpenChats = onNavigateToChats,
                            )
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

                    // What following the end scrolls to: below the last line
                    // of whatever is last, however tall that is.
                    item(key = "end") { Spacer(Modifier.fillMaxWidth().height(1.dp)) }
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

            // The voice bar stands in for the composer while voice mode is on (#341).
            if (voiceState.voiceMode) {
                VoiceBar(
                    phase = voicePhase,
                    wakeWord = state.assistant?.triggerWord,
                    answererName = state.persona?.name ?: ChatViewModel.ASSISTANT_NAME,
                    lastTranscript = voiceState.lastTranscript,
                    idleDeadlineMs = voiceState.idleDeadlineMs,
                    onEnd = { viewModel.setVoiceMode(false) },
                    onRetry = viewModel::retryMic,
                    onOpenAssistant = onNavigateToAssistant,
                    onOpenAppSettings = {
                        context.startActivity(
                            android.content.Intent(
                                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                android.net.Uri.fromParts("package", context.packageName, null),
                            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                )
            } else {
                ChatInput(
                    text = state.inputText,
                    onTextChange = viewModel::setInputText,
                    onSend = { viewModel.sendMessage() },
                    onCancel = viewModel::cancelStream,
                    onImageSelected = viewModel::addImage,
                    onRemoveImage = viewModel::removeImage,
                    selectedImages = state.selectedImages,
                    isStreaming = streaming.isStreaming,
                )
            }
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
 * The model sheet — the model name on the header, or "Choose a model" on the
 * no-model prompt.
 *
 * The subtitle is the contract: the model is the assistant's, so it changes for
 * every persona, and it applies from the next message. Without it the sheet
 * reads like a per-conversation setting, which is exactly what it is not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSheet(
    modal: ChatModal.ModelPicker,
    currentModelName: String?,
    currentProvider: String?,
    onDismiss: () -> Unit,
    onPick: (ModelInfo) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text("Model", style = MaterialTheme.typography.titleLarge)
            Text(
                text = "Applies from the next message. The persona and its memory stay the same.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when {
            modal.loading -> Box(
                modifier = Modifier.fillMaxWidth().padding(32.dp),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator(modifier = Modifier.size(28.dp)) }

            modal.models.isEmpty() -> Text(
                text = "No models. Is the model host running?",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
            )

            else -> modal.models.groupBy { it.provider }.toSortedMap().forEach { (provider, models) ->
                Text(
                    text = provider.uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 2.dp),
                )
                models.sortedBy { it.name }.forEach { model ->
                    val isCurrent = model.name == currentModelName && model.provider == currentProvider
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { if (isCurrent) onDismiss() else onPick(model) }
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                    ) {
                        Text(
                            text = model.name,
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (isCurrent) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = "In use",
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

/** The assistant answering as itself, as the first choice in the persona sheet (#302). */
@Composable
private fun AssistantRow(
    isCurrent: Boolean,
    onPick: () -> Unit,
    onDismiss: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { if (isCurrent) onDismiss() else onPick() }
            .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
        PersonaAvatar(name = ChatViewModel.ASSISTANT_NAME, avatarUrl = null, size = 40.dp, fontSize = 13.sp)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = ChatViewModel.ASSISTANT_NAME,
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = "No persona — the assistant answers as itself",
                style = KurisuTheme.extraTypography.metadataSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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

/**
 * The per-conversation persona switch.
 *
 * The subtitle is the whole contract: this conversation moves, the assistant's
 * selection does not. Without it the sheet reads like a global setting and every
 * future chat looks changed.
 *
 * The first row is the assistant itself — no persona (#302). A started chat is
 * handed to it with `persona_id: null`, and a chat that does not exist yet
 * starts with the assistant when its first message names nobody (#334).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PersonaSheet(
    modal: ChatModal.PersonaPicker,
    selectedPersonaName: String?,
    currentPersonaId: Int?,
    baseUrl: String,
    onDismiss: () -> Unit,
    onPick: (Persona?) -> Unit,
    onManagePersonas: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text("Persona", style = MaterialTheme.typography.titleLarge)
            Text(
                text = if (selectedPersonaName != null) {
                    "This conversation only — new chats stay with $selectedPersonaName"
                } else {
                    "This conversation only — new chats stay with the assistant"
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

            else -> AssistantRow(
                isCurrent = currentPersonaId == null,
                onPick = { onPick(null) },
                onDismiss = onDismiss,
            )
        }

        when {
            modal.loading -> Unit

            modal.personas.isEmpty() -> Text(
                text = "No personas yet. Create one to give the assistant a name, voice and face.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
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
    CharacterConfigKind.of(persona.characterConfig).metaLabel(),
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
