package com.kurisu.assistant.ui.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.kurisu.assistant.ui.theme.KurisuTheme
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatInput(
    text: String,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onCancel: () -> Unit,
    onImageSelected: (Uri) -> Unit,
    onRemoveImage: (Int) -> Unit,
    selectedImages: List<Uri>,
    isStreaming: Boolean,
    isInteractionMode: Boolean,
    /**
     * Instant at which voice mode gives up, or null when no idle timer is armed
     * (still streaming, still speaking). Drives the countdown; see
     * [com.kurisu.assistant.service.VoiceInteractionState.idleDeadlineMs].
     */
    voiceIdleDeadlineMs: Long? = null,
    onStopVoice: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent(),
    ) { uri ->
        uri?.let(onImageSelected)
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        // Voice bar — replaces the composer while voice mode is on.
        if (isInteractionMode) {
            VoiceBar(
                idleDeadlineMs = voiceIdleDeadlineMs,
                onStop = onStopVoice,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }

        // Slash commands. A leading "/" opens the palette.
        //
        // Two rules keep a MODAL sheet from getting in the way, which the old
        // inline dropdown never had to care about:
        //  - only while the command word is still being typed, so picking one
        //    (which appends a space) closes the sheet instead of re-matching it;
        //  - dismissing suppresses it until the composer stops being a command,
        //    so someone typing "/usr/bin/…" is not fought on every keystroke.
        val isCommandPrefix = text.startsWith("/") && !text.contains(' ')
        var slashSuppressed by remember { mutableStateOf(false) }
        LaunchedEffect(isCommandPrefix) { if (!isCommandPrefix) slashSuppressed = false }

        val suggestions = remember(text, isCommandPrefix) {
            if (isCommandPrefix) SlashCommands.autocomplete(text) else emptyList()
        }
        if (!slashSuppressed && suggestions.isNotEmpty()) {
            SlashCommandSheet(
                commands = suggestions,
                onPick = { cmd -> onTextChange("/${cmd.name} ") },
                onDismiss = { slashSuppressed = true },
            )
        }

        // Image previews
        if (selectedImages.isNotEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(bottom = 6.dp),
            ) {
                selectedImages.forEachIndexed { index, uri ->
                    Box {
                        AsyncImage(
                            model = uri,
                            contentDescription = "Selected image",
                            modifier = Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)),
                            contentScale = ContentScale.Crop,
                        )
                        Icon(
                            Icons.Default.Close,
                            contentDescription = "Remove image",
                            modifier = Modifier
                                .size(18.dp)
                                .align(Alignment.TopEnd)
                                .offset(x = 4.dp, y = (-4).dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.error)
                                .clickable { onRemoveImage(index) }
                                .padding(2.dp),
                            tint = MaterialTheme.colorScheme.onError,
                        )
                    }
                }
            }
        }

        // Input row — Messenger-style pill
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(28.dp),
        ) {
            Row(
                verticalAlignment = Alignment.Bottom,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
            ) {
                // Attach image
                IconButton(
                    onClick = { imagePickerLauncher.launch("image/*") },
                    enabled = !isStreaming,
                    modifier = Modifier.size(36.dp),
                ) {
                    Icon(
                        Icons.Default.Add,
                        contentDescription = "Attach",
                        modifier = Modifier.size(20.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // Text field — no border, transparent background
                TextField(
                    value = text,
                    onValueChange = onTextChange,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(max = 120.dp),
                    placeholder = {
                        Text(
                            "Message...",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    },
                    maxLines = 5,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                        disabledContainerColor = androidx.compose.ui.graphics.Color.Transparent,
                        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        disabledIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    ),
                    textStyle = MaterialTheme.typography.bodyMedium,
                )

                // Send / Stop
                if (isStreaming) {
                    FilledIconButton(
                        onClick = onCancel,
                        modifier = Modifier.size(36.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) {
                        Icon(
                            Icons.Default.Stop,
                            contentDescription = "Stop",
                            modifier = Modifier.size(18.dp),
                        )
                    }
                } else {
                    val hasContent = text.isNotBlank() || selectedImages.isNotEmpty()
                    FilledIconButton(
                        onClick = onSend,
                        enabled = hasContent,
                        modifier = Modifier.size(36.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = if (hasContent) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = if (hasContent) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                        ),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Send",
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * "Voice active" bar. Replaces the chip that only ever said the mode was on.
 *
 * The countdown is derived from a deadline instant rather than a ticking
 * counter, so it stays honest across recomposition and a screen that was off:
 * the bar shows the seconds actually left, not the seconds it managed to count.
 */
@Composable
private fun VoiceBar(
    idleDeadlineMs: Long?,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var remainingSeconds by remember(idleDeadlineMs) {
        mutableStateOf(secondsUntil(idleDeadlineMs))
    }
    LaunchedEffect(idleDeadlineMs) {
        if (idleDeadlineMs == null) {
            remainingSeconds = null
            return@LaunchedEffect
        }
        while (true) {
            remainingSeconds = secondsUntil(idleDeadlineMs)
            if ((remainingSeconds ?: 0) <= 0) break
            delay(250)
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = RoundedCornerShape(22.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            Icon(
                Icons.Outlined.GraphicEq,
                contentDescription = null,
                modifier = Modifier.size(22.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Voice active — sends when you stop",
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                remainingSeconds?.let { seconds ->
                    Text(
                        text = "idle timeout in ${seconds}s",
                        style = KurisuTheme.extraTypography.metadataSmall,
                        color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.75f),
                    )
                }
            }
            FilledIconButton(
                onClick = onStop,
                modifier = Modifier.size(36.dp),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.18f),
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            ) {
                Icon(
                    Icons.Outlined.Stop,
                    contentDescription = "Stop voice mode",
                    modifier = Modifier.size(19.dp),
                )
            }
        }
    }
}

/** Whole seconds left until [deadlineMs], floored at zero. Null when unarmed. */
internal fun secondsUntil(deadlineMs: Long?, nowMs: Long = System.currentTimeMillis()): Int? {
    if (deadlineMs == null) return null
    val remaining = deadlineMs - nowMs
    if (remaining <= 0L) return 0
    return ((remaining + 999L) / 1000L).toInt()
}

/** The slash-command palette. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SlashCommandSheet(
    commands: List<SlashCommand>,
    onPick: (SlashCommand) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            text = "Commands",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 10.dp),
        )
        commands.forEach { cmd ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onPick(cmd) }
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Text(
                    text = "/${cmd.name}",
                    style = KurisuTheme.extraTypography.metadata,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.widthIn(min = 92.dp),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    text = cmd.description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
