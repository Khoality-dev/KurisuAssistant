package com.kurisu.assistant.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Pending
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.data.model.MessageRawData
import com.kurisu.assistant.ui.theme.JetBrainsMono
import com.kurisu.assistant.ui.theme.KurisuTheme
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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // A tool call is not the persona talking, so it is not drawn as a bubble.
    // It is a rail hanging off the reply it belongs to: what ran, how it went,
    // how long it took, and what came back.
    if (isTool) {
        ToolRail(message = message, modifier = modifier)
        return
    }

    // ── Color roles (light/dark derived once, in the theme) ────
    val extra = KurisuTheme.extraColors

    val bgColor = if (isUser) extra.bubbleUser else extra.bubbleNeutral
    val textOnBubble = if (isUser) extra.bubbleUserContent else MaterialTheme.colorScheme.onSurface
    val labelColor = if (isUser) {
        extra.bubbleUserContent.copy(alpha = 0.85f)
    } else {
        MaterialTheme.colorScheme.primary
    }

    // Who said this — the persona stamped on THIS message, not whoever the
    // conversation is bound to now. Switching persona must not rewrite history
    // by making yesterday's answers look like they came from today's speaker.
    val speaker = message.personaName ?: message.persona?.name ?: message.name
    val label = if (isUser) "You" else (speaker ?: message.role.replaceFirstChar { it.uppercase() })

    // Avatar URL
    val agentAvatarUrl = message.persona?.avatarUuid?.let { "$baseUrl/images/$it" }

    // Action states
    var showActions by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var showRawDialog by remember { mutableStateOf(false) }
    var rawData by remember { mutableStateOf<MessageRawData?>(null) }
    var rawLoading by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        // Avatar on left for non-user
        if (!isUser) {
            PersonaAvatar(name = speaker, avatarUrl = agentAvatarUrl)
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
                modifier = Modifier.widthIn(min = 80.dp).wrapContentWidth().combinedClickable(
                    onClick = { if (showActions) showActions = false },
                    onLongClick = { showActions = !showActions },
                ),
            ) {
                Column(
                    modifier = Modifier.padding(10.dp).animateContentSize(),
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                        ),
                        color = labelColor,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )

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
                                fontFamily = JetBrainsMono,
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
                                fontFamily = JetBrainsMono,
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
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = JetBrainsMono),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * One tool call, drawn as a rail rather than a bubble.
 *
 * The rail carries what a bubble never could: whether the step was an ordinary
 * tool or a delegation to a sub-agent, which model ran it, and how long it took.
 * `tool_kind` and `duration_ms` reach the client only on the live stream, so a
 * reloaded transcript quietly drops the tag and the timing rather than guessing.
 */
@Composable
fun ToolRail(
    message: Message,
    modifier: Modifier = Modifier,
) {
    val extra = KurisuTheme.extraColors
    val mono = KurisuTheme.extraTypography

    val rail = remember(message) { ToolRailModel.from(message) }
    val isError = rail.status == ToolRunStatus.FAILED
    val isSubAgent = rail.isSubAgent

    val statusIcon = when (rail.status) {
        ToolRunStatus.SUCCEEDED -> Icons.Outlined.CheckCircle
        ToolRunStatus.FAILED -> Icons.Outlined.ErrorOutline
        ToolRunStatus.RUNNING -> Icons.Outlined.Pending
    }
    val statusTint = when (rail.status) {
        ToolRunStatus.SUCCEEDED -> extra.toolSuccessContent
        ToolRunStatus.FAILED -> extra.toolErrorContent
        ToolRunStatus.RUNNING -> MaterialTheme.colorScheme.primary
    }
    val nameColor = if (rail.status == ToolRunStatus.RUNNING) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurface
    }
    val meta = rail.meta
    val argsLine = rail.args

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .padding(start = 50.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
    ) {
        // The rail itself — the vertical line that ties the steps to the reply.
        Box(
            modifier = Modifier
                .width(2.dp)
                .fillMaxHeight()
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
        Spacer(Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                if (isSubAgent) {
                    Surface(
                        color = extra.subAgentTagBackground,
                        contentColor = extra.subAgentTagContent,
                        shape = RoundedCornerShape(6.dp),
                    ) {
                        Text(
                            text = "sub-agent",
                            style = mono.metadataSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
                Text(
                    text = rail.name,
                    style = mono.metadata,
                    color = nameColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Icon(
                    imageVector = statusIcon,
                    contentDescription = rail.status.name.lowercase(),
                    modifier = Modifier.size(15.dp),
                    tint = statusTint,
                )
                Spacer(Modifier.weight(1f))
                if (meta.isNotEmpty()) {
                    Text(
                        text = meta,
                        style = mono.metadataSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }

            if (argsLine.isNotEmpty()) {
                Text(
                    text = argsLine,
                    style = mono.metadataSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (message.content.isNotBlank()) {
                Text(
                    text = message.content,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (isError) extra.toolErrorContent else MaterialTheme.colorScheme.onSurface,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

enum class ToolRunStatus { RUNNING, SUCCEEDED, FAILED }

/**
 * Everything the rail draws about one tool call, derived once and without a
 * composition — so the rules that decide "sub-agent tag or not" and "which model,
 * how long" can be tested directly rather than through a screenshot.
 */
data class ToolRailModel(
    val name: String,
    val status: ToolRunStatus,
    val isSubAgent: Boolean,
    val meta: String,
    val args: String,
) {
    companion object {
        fun from(message: Message): ToolRailModel {
            val status = when (message.toolStatus) {
                "success" -> ToolRunStatus.SUCCEEDED
                "error", "denied" -> ToolRunStatus.FAILED
                else -> ToolRunStatus.RUNNING
            }
            // `tool_kind` is stream-only. A reloaded transcript has it null, so
            // the tag is omitted rather than guessed from the tool's name.
            val isSubAgent = message.toolKind == "sub_agent"

            // The model is worth naming only for a delegated step: an ordinary
            // tool runs no model, and repeating the assistant's own model on
            // every row would say nothing.
            val meta = buildList {
                if (isSubAgent) message.modelName?.takeIf { it.isNotBlank() }?.let(::add)
                message.durationMs?.let { add(formatToolDuration(it)) }
            }.joinToString(" · ").ifEmpty {
                if (status == ToolRunStatus.RUNNING) "running" else ""
            }

            return ToolRailModel(
                name = message.name ?: "tool",
                status = status,
                isSubAgent = isSubAgent,
                meta = meta,
                args = formatToolArgs(message.toolArgs),
            )
        }
    }
}

/** "800" → "0.8s". Sub-second calls keep a decimal rather than reading "0s". */
internal fun formatToolDuration(durationMs: Int): String {
    val tenths = Math.round(durationMs / 100.0)
    return "${tenths / 10}.${tenths % 10}s"
}

/** `{"query": "halden invoice"}` → `query: halden invoice`. */
internal fun formatToolArgs(args: kotlinx.serialization.json.JsonObject?): String {
    if (args.isNullOrEmpty()) return ""
    return args.entries.joinToString(", ") { (k, v) ->
        val raw = v.toString().removeSurrounding("\"")
        "$k: ${if (raw.length > 60) raw.take(60) + "…" else raw}"
    }
}
