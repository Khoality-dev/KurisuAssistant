package com.kurisu.assistant.ui.conversations

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import com.kurisu.assistant.ui.common.personaInitials
import com.kurisu.assistant.ui.theme.KurisuTheme
import com.kurisu.assistant.ui.update.UpdateDialog

/**
 * The Chats list — the app's list of conversations.
 *
 * [onOpenChat] is the single navigation hook: it is handed the conversation to
 * show, or null for a brand-new chat. The view model has already put that id on
 * [com.kurisu.assistant.service.CoreState] by the time it is called, so a caller
 * that only navigates to the chat route is correct.
 *
 * There is no search field and no persona picker here. Search was cut rather
 * than half-wired, and a new chat silently takes the assistant's default
 * persona — the only persona choice in the app is the per-conversation override
 * on the chat header.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    onOpenChat: (conversationId: Int?) -> Unit,
    onOpenMenu: (() -> Unit)? = null,
    viewModel: ConversationsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val coreServiceState by viewModel.coreServiceState.collectAsState()

    // Ask for the mic once and start the service, exactly as the dead Home
    // screen did — without it the strip below is a control that cannot work.
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted && !coreServiceState.isServiceRunning) viewModel.startService()
    }
    LaunchedEffect(Unit) {
        if (!coreServiceState.isServiceRunning) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // The wake word opens the chat. It names no persona: whoever the
    // conversation is bound to answers.
    LaunchedEffect(Unit) {
        viewModel.wakeWord.collect { onOpenChat(coreServiceState.conversationId) }
    }

    if (state.updateRelease != null) {
        UpdateDialog(
            release = state.updateRelease!!,
            progress = state.updateProgress,
            apkFile = state.updateApkFile,
            onDownload = viewModel::downloadAndInstall,
            onDismiss = viewModel::dismissUpdate,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Chats") },
                navigationIcon = {
                    if (onOpenMenu != null) {
                        IconButton(onClick = onOpenMenu) {
                            Icon(Icons.Outlined.Menu, contentDescription = "Menu")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::load) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { viewModel.startNewChat { onOpenChat(null) } },
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("New chat") },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            MicStatusBar(
                isListening = coreServiceState.isRecording,
                isProcessing = coreServiceState.isProcessingAsr,
                lastTranscript = coreServiceState.lastTranscript,
                triggerWord = state.triggerWord,
                onClick = viewModel::toggleRecording,
            )

            // A failure with rows already on screen is a banner, not a wipe: the
            // stale list is still the most useful thing we can show.
            if (state.error != null && state.rows.isNotEmpty()) {
                ErrorBanner(message = state.error!!, onRetry = viewModel::load)
            }

            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    state.isLoading && state.rows.isEmpty() -> {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }

                    state.error != null && state.rows.isEmpty() -> {
                        ErrorState(message = state.error!!, onRetry = viewModel::load)
                    }

                    state.rows.isEmpty() -> EmptyState()

                    else -> LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        // Room for the FAB at the end of the list.
                        contentPadding = PaddingValues(bottom = 88.dp),
                    ) {
                        items(state.rows, key = { it.id }) { row ->
                            ConversationRow(
                                row = row,
                                onClick = {
                                    viewModel.openConversation(row.id)
                                    onOpenChat(row.id)
                                },
                            )
                            HorizontalDivider(
                                modifier = Modifier.padding(start = 74.dp),
                                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The mic strip. Lifted from the dead Home screen, which already read the three
 * fields it needs off [com.kurisu.assistant.service.CoreState]; the copy is the
 * design's.
 */
@Composable
private fun MicStatusBar(
    isListening: Boolean,
    isProcessing: Boolean,
    lastTranscript: String?,
    triggerWord: String?,
    onClick: () -> Unit,
) {
    val active = isListening || isProcessing
    val containerColor by animateColorAsState(
        targetValue = if (active) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        label = "mic_strip_color",
    )
    val contentColor = if (active) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    val title = when {
        isProcessing -> "Transcribing…"
        isListening -> lastTranscript?.takeIf { it.isNotBlank() }?.let { "“$it”" } ?: "Listening"
        else -> "Microphone off"
    }
    // Transcribing keeps the listening subtitle: the mic is still on, only the
    // title changes, so the strip does not rewrite both lines mid-utterance.
    val subtitle = when {
        !active -> "tap to listen for trigger words"
        triggerWord != null -> "listening · say “$triggerWord” to send"
        else -> "listening"
    }

    Surface(
        color = containerColor,
        contentColor = contentColor,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isProcessing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = contentColor,
                )
            } else {
                Icon(
                    imageVector = if (isListening) Icons.Outlined.GraphicEq else Icons.Outlined.MicOff,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = if (isListening) MaterialTheme.colorScheme.primary else contentColor,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = contentColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = subtitle,
                    style = KurisuTheme.extraTypography.metadataSmall,
                    color = contentColor.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ConversationRow(
    row: ConversationRowUi,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PersonaAvatar(name = row.personaName, avatarUrl = row.avatarUrl, size = 48.dp)

        Spacer(Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (row.timestamp != null) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = formatRelativeTime(row.timestamp),
                        style = KurisuTheme.extraTypography.metadataSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(3.dp))
            Text(
                text = row.preview ?: "No messages yet",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (row.personaName != null) {
                Spacer(Modifier.height(3.dp))
                Text(
                    // Who answers here. The model is deliberately absent: one
                    // assistant, one model, so it would repeat on every row.
                    text = row.personaName,
                    style = KurisuTheme.extraTypography.metadataSmall,
                    color = MaterialTheme.colorScheme.outline,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}


@Composable
private fun PersonaAvatar(
    name: String?,
    avatarUrl: String?,
    size: Dp,
) {
    val container = MaterialTheme.colorScheme.primaryContainer
    val content = MaterialTheme.colorScheme.onPrimaryContainer
    if (avatarUrl != null) {
        SubcomposeAsyncImage(
            model = avatarUrl,
            contentDescription = name,
            modifier = Modifier.size(size).clip(CircleShape),
            contentScale = ContentScale.Crop,
            loading = { InitialsAvatar(name, size, container, content) },
            error = { InitialsAvatar(name, size, container, content) },
            success = { SubcomposeAsyncImageContent() },
        )
    } else {
        InitialsAvatar(name, size, container, content)
    }
}

@Composable
private fun InitialsAvatar(
    name: String?,
    size: Dp,
    containerColor: Color,
    contentColor: Color,
) {
    Surface(modifier = Modifier.size(size), shape = CircleShape, color = containerColor) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = personaInitials(name),
                style = MaterialTheme.typography.titleSmall,
                color = contentColor,
            )
        }
    }
}

@Composable
private fun EmptyState() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Text(
                "No conversations yet",
                style = MaterialTheme.typography.bodyLarge,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Start one and it shows up here",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Icon(
                Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                "Could not load your chats",
                style = MaterialTheme.typography.bodyLarge,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                message,
                style = KurisuTheme.extraTypography.metadata,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
            TextButton(onClick = onRetry) { Text("Try again") }
        }
    }
}

@Composable
private fun ErrorBanner(message: String, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(
            modifier = Modifier.padding(start = 14.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = message,
                style = KurisuTheme.extraTypography.metadataSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) { Text("Try again") }
        }
    }
}
