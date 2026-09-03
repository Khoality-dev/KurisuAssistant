package com.kurisu.assistant.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.graphics.luminance
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import kotlinx.coroutines.launch

@OptIn(ExperimentalFoundationApi::class)
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
    val isDark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // ── Color scheme matching desktop ──────────────────────────
    val toolSuccess = isTool && message.toolStatus == "success"
    val toolError = isTool && (message.toolStatus == "error" || message.toolStatus == "denied")

    val bgColor = when {
        isUser -> if (isDark) Color(0xFF0066CC) else Color(0xFF0084FF)
        toolSuccess -> if (isDark) Color(0xFF002A00) else Color(0xFFE8F5E9)
        toolError -> if (isDark) Color(0xFF2A0000) else Color(0xFFFCE4EC)
        isTool -> if (isDark) Color(0xFF1A1A1A) else Color(0xFFE4E6EB)
        else -> if (isDark) Color(0xFF262626) else Color(0xFFE4E6EB)
    }
    val borderColor = when {
        toolSuccess -> if (isDark) Color(0xFF006600) else Color(0xFF81C784)
        toolError -> if (isDark) Color(0xFF660000) else Color(0xFFE57373)
        else -> Color.Transparent
    }
    val textOnBubble = when {
        isUser -> Color.White
        toolSuccess -> if (isDark) Color(0xFF81C784) else Color(0xFF2E7D32)
        toolError -> if (isDark) Color(0xFFE57373) else Color(0xFFC62828)
        else -> MaterialTheme.colorScheme.onSurface
    }
    val labelColor = when {
        isUser -> Color.White.copy(alpha = 0.85f)
        toolSuccess -> if (isDark) Color(0xFF81C784) else Color(0xFF2E7D32)
        toolError -> if (isDark) Color(0xFFE57373) else Color(0xFFC62828)
        isTool -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.primary
    }

    // ── Label: matches desktop format ──────────────────────────
    val label = when {
        isUser -> "You"
        isTool -> {
            if (message.name != null && message.toolArgs != null) {
                val argsStr = message.toolArgs.entries.joinToString(", ") { (k, v) ->
                    val s = v.toString().removeSurrounding("\"")
                    "$k: ${if (s.length > 40) s.take(40) + "..." else s}"
                }
                "${message.name}($argsStr)"
            } else {
                message.name ?: "Tool"
            }
        }
        else -> {
            message.personaName ?: message.agent?.personaName
                ?: message.agent?.name ?: message.name
                ?: message.role.replaceFirstChar { it.uppercase() }
        }
    }

    // Avatar URL
    val agentAvatarUrl = message.agent?.avatarUuid?.let { "$baseUrl/images/$it" }

    // Action states
    var showActions by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var showRawDialog by remember { mutableStateOf(false) }
    var rawData by remember { mutableStateOf<MessageRawData?>(null) }
    var rawLoading by remember { mutableStateOf(false) }
    var toolExpanded by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        // Avatar on left for non-user
        if (!isUser) {
            if (isTool) {
                Surface(
                    modifier = Modifier.size(32.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) {
                    Icon(
                        Icons.Default.Build,
                        contentDescription = null,
                        modifier = Modifier.padding(7.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                AvatarIcon(avatarUrl = agentAvatarUrl)
            }
            Spacer(Modifier.width(8.dp))
        }

        Column(
            modifier = Modifier.wrapContentWidth().widthIn(max = 280.dp),
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        ) {
            // ── Messenger-style bubble ─────────────────────
            val bubbleShape = RoundedCornerShape(
                topStart = 18.dp,
                topEnd = 18.dp,
                bottomStart = if (isUser) 18.dp else 4.dp,
                bottomEnd = if (isUser) 4.dp else 18.dp,
            )
            Surface(
                color = bgColor,
                shape = bubbleShape,
                border = if (borderColor != Color.Transparent) androidx.compose.foundation.BorderStroke(1.dp, borderColor) else null,
                modifier = Modifier.widthIn(min = 80.dp).wrapContentWidth().combinedClickable(
                    onClick = {
                        if (isTool) toolExpanded = !toolExpanded
                        else if (showActions) showActions = false
                    },
                    onLongClick = { showActions = !showActions },
                ),
            ) {
                Column(
                    modifier = Modifier.padding(10.dp).animateContentSize(),
                ) {
                    // Header row: label + expand icon for tools
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = label,
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
                            color = labelColor,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier,
                        )
                        if (isTool) {
                            Spacer(Modifier.width(4.dp))
                            Icon(
                                if (toolExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                contentDescription = "Toggle",
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    // Content — collapsed by default for tool messages
                    if (!isTool || toolExpanded) {
                        Spacer(Modifier.height(6.dp))

                        // Thinking section (collapsible)
                        if (!message.thinking.isNullOrBlank()) {
                            ThinkingSection(thinking = message.thinking)
                            Spacer(Modifier.height(6.dp))
                        }

                        // Image attachments
                        if (!message.images.isNullOrEmpty()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                for (imageId in message.images.take(3)) {
                                    AsyncImage(
                                        model = "$baseUrl/images/$imageId",
                                        contentDescription = "Image",
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
                                    color = textOnBubble,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            } else {
                                MarkdownText(text = message.content)
                            }
                        }
                    }
                }
            }

            // ── Long-press context menu ──────────────────
            DropdownMenu(
                expanded = showActions,
                onDismissRequest = { showActions = false },
            ) {
                // Copy
                DropdownMenuItem(
                    text = { Text(if (copied) "Copied!" else "Copy") },
                    leadingIcon = {
                        Icon(
                            if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    onClick = {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("message", message.content))
                        copied = true
                        showActions = false
                    },
                )

                // Resend (user messages only)
                if (isUser && onResend != null && message.id != null) {
                    DropdownMenuItem(
                        text = { Text("Resend") },
                        leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(18.dp)) },
                        onClick = {
                            showActions = false
                            onResend(message.id, message.content)
                        },
                    )
                }

                // Raw data (assistant/tool messages)
                if (!isUser && message.hasRawData == true && onGetRawData != null) {
                    DropdownMenuItem(
                        text = { Text("Raw data") },
                        leadingIcon = { Icon(Icons.Default.Code, contentDescription = null, modifier = Modifier.size(18.dp)) },
                        onClick = {
                            showActions = false
                            showRawDialog = true
                            if (rawData == null) {
                                rawLoading = true
                                scope.launch {
                                    rawData = onGetRawData(message.id!!)
                                    rawLoading = false
                                }
                            }
                        },
                    )
                }

                // Delete
                if (onDelete != null && message.id != null) {
                    DropdownMenuItem(
                        text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error) },
                        onClick = {
                            showActions = false
                            onDelete(message.id)
                        },
                    )
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
                    Text("Raw Input", style = MaterialTheme.typography.titleSmall)
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            text = rawData.rawInput?.toString()?.let { formatJson(it) }
                                ?: "No raw input data",
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                            ),
                            modifier = Modifier.padding(8.dp),
                        )
                    }
                    Text("Raw Output", style = MaterialTheme.typography.titleSmall)
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
            contentDescription = "Avatar",
            modifier = Modifier.size(avatarSize).clip(CircleShape),
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
                tint = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

@Composable
private fun ThinkingSection(thinking: String) {
    var expanded by remember { mutableStateOf(false) }

    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        shape = RoundedCornerShape(8.dp),
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Default.Psychology,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = "Thinking",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = "Toggle",
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = thinking,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
