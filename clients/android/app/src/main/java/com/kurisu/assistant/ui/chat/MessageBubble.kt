package com.kurisu.assistant.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import kotlinx.coroutines.launch

@Composable
fun MessageBubble(
    message: Message,
    baseUrl: String,
    onDelete: ((messageId: Int) -> Unit)? = null,
    onResend: ((messageId: Int, text: String) -> Unit)? = null,
    onGetRawData: (suspend (messageId: Int) -> MessageRawData?)? = null,
    modifier: Modifier = Modifier,
) {
    val isUser = message.role == "user"
    val isTool = message.role == "tool"
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val bubbleColor = when {
        isUser -> MaterialTheme.colorScheme.primary
        isTool -> MaterialTheme.colorScheme.tertiaryContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val contentColor = when {
        isUser -> MaterialTheme.colorScheme.onPrimary
        isTool -> MaterialTheme.colorScheme.onTertiaryContainer
        else -> MaterialTheme.colorScheme.onSurface
    }
    val shape = RoundedCornerShape(
        topStart = 16.dp,
        topEnd = 16.dp,
        bottomStart = if (isUser) 16.dp else 4.dp,
        bottomEnd = if (isUser) 4.dp else 16.dp,
    )

    // Agent avatar URL
    val agentAvatarUuid = message.agent?.avatarUuid
    val agentAvatarUrl = if (agentAvatarUuid != null) "$baseUrl/images/$agentAvatarUuid" else null

    // Action states
    var showActions by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var showRawDialog by remember { mutableStateOf(false) }
    var rawData by remember { mutableStateOf<MessageRawData?>(null) }
    var rawLoading by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // Avatar on left for assistant
        if (!isUser) {
            AvatarIcon(avatarUrl = agentAvatarUrl)
            Spacer(Modifier.width(6.dp))
        }

        @OptIn(ExperimentalFoundationApi::class)
        Column(
            modifier = Modifier.widthIn(max = 300.dp),
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        ) {
            // Bubble — long press to show/hide actions
            Column(
                modifier = Modifier
                    .clip(shape)
                    .background(bubbleColor)
                    .combinedClickable(
                        onClick = { if (showActions) showActions = false },
                        onLongClick = { showActions = !showActions },
                    )
                    .padding(12.dp)
                    .animateContentSize(),
            ) {
                // Agent name label
                if (!isUser && message.name != null) {
                    Text(
                        text = message.name,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(4.dp))
                }

                // Thinking section (collapsible)
                if (!message.thinking.isNullOrBlank()) {
                    ThinkingSection(thinking = message.thinking)
                    Spacer(Modifier.height(8.dp))
                }

                // Image attachments (user messages)
                if (isUser && !message.images.isNullOrEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (imageId in message.images.take(3)) {
                            AsyncImage(
                                model = "$baseUrl/images/$imageId",
                                contentDescription = "Attached image",
                                modifier = Modifier
                                    .size(80.dp)
                                    .clip(RoundedCornerShape(8.dp)),
                                contentScale = ContentScale.Crop,
                            )
                        }
                    }
                    if (message.content.isNotBlank()) Spacer(Modifier.height(4.dp))
                }

                // Content
                if (message.content.isNotBlank()) {
                    if (isUser) {
                        Text(
                            text = message.content,
                            color = contentColor,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        MarkdownText(text = message.content)
                    }
                }
            }

            // Action buttons — revealed on long press
            AnimatedVisibility(
                visible = showActions && message.id != null,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                Row(
                    modifier = Modifier.padding(top = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(0.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Copy
                    IconButton(
                        onClick = {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("message", message.content))
                            copied = true
                        },
                        modifier = Modifier.size(28.dp),
                    ) {
                        Icon(
                            imageVector = if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                            contentDescription = "Copy",
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    // Resend (user messages only)
                    if (isUser && onResend != null && message.id != null) {
                        IconButton(
                            onClick = {
                                showActions = false
                                onResend(message.id, message.content)
                            },
                            modifier = Modifier.size(28.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Refresh,
                                contentDescription = "Resend",
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    // Show raw data (non-user messages with raw data)
                    if (!isUser && message.hasRawData == true && onGetRawData != null) {
                        IconButton(
                            onClick = {
                                showRawDialog = true
                                if (rawData == null) {
                                    rawLoading = true
                                    scope.launch {
                                        rawData = onGetRawData(message.id!!)
                                        rawLoading = false
                                    }
                                }
                            },
                            modifier = Modifier.size(28.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Code,
                                contentDescription = "Raw data",
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    // Delete
                    if (onDelete != null && message.id != null) {
                        IconButton(
                            onClick = { onDelete(message.id) },
                            modifier = Modifier.size(28.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Delete,
                                contentDescription = "Delete from here",
                                modifier = Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }

            // Reset copied after delay
            LaunchedEffect(copied) {
                if (copied) {
                    kotlinx.coroutines.delay(2000)
                    copied = false
                }
            }
        }
    }

    // Raw data dialog
    if (showRawDialog) {
        RawDataDialog(
            rawData = rawData,
            isLoading = rawLoading,
            onDismiss = { showRawDialog = false },
        )
    }
}

@Composable
private fun RawDataDialog(
    rawData: MessageRawData?,
    isLoading: Boolean,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
        title = { Text("Raw LLM Data") },
        text = {
            if (isLoading) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            } else if (rawData != null) {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // Raw Input
                    Text(
                        text = "Raw Input",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            text = rawData.rawInput?.toString()
                                ?.let { formatJson(it) }
                                ?: "No raw input data",
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                            ),
                            modifier = Modifier.padding(8.dp),
                        )
                    }

                    // Raw Output
                    Text(
                        text = "Raw Output",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            text = rawData.rawOutput ?: "No raw output data",
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                            ),
                            modifier = Modifier.padding(8.dp),
                        )
                    }
                }
            } else {
                Text("Failed to load raw data")
            }
        },
    )
}

/** Best-effort JSON pretty-printing */
private fun formatJson(json: String): String {
    return try {
        val element = kotlinx.serialization.json.Json.parseToJsonElement(json)
        kotlinx.serialization.json.Json { prettyPrint = true }.encodeToString(
            kotlinx.serialization.json.JsonElement.serializer(),
            element,
        )
    } catch (_: Exception) {
        json
    }
}

@Composable
private fun AvatarIcon(avatarUrl: String?) {
    val avatarSize = 32.dp

    if (avatarUrl != null) {
        AsyncImage(
            model = avatarUrl,
            contentDescription = "Agent avatar",
            modifier = Modifier
                .size(avatarSize)
                .clip(CircleShape),
            contentScale = ContentScale.Crop,
        )
    } else {
        Surface(
            modifier = Modifier.size(avatarSize),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.secondaryContainer,
        ) {
            Icon(
                imageVector = Icons.Default.SmartToy,
                contentDescription = "Agent",
                modifier = Modifier.padding(6.dp),
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
    }
}

@Composable
private fun ThinkingSection(thinking: String) {
    var expanded by remember { mutableStateOf(false) }

    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.5f),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Thinking",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = "Toggle thinking",
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = thinking,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
