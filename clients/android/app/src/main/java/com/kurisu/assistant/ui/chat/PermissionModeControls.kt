package com.kurisu.assistant.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.data.model.PermissionMode

/**
 * The account's permission mode beside the input (#360): a chip naming it. Read
 * only and Full access are tinted, so neither is mistaken for the default.
 * Mirrors the desktop's `PermissionModeChip`.
 */
@Composable
fun PermissionModeChip(mode: PermissionMode, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (container, content) = when (mode) {
        PermissionMode.ASK -> scheme.surface to scheme.onSurfaceVariant
        PermissionMode.READ_ONLY -> scheme.secondaryContainer to scheme.onSecondaryContainer
        PermissionMode.FULL -> scheme.errorContainer to scheme.onErrorContainer
    }
    AssistChip(
        onClick = onClick,
        label = { Text(mode.title) },
        leadingIcon = { Icon(Icons.Outlined.Shield, contentDescription = null, modifier = Modifier.size(16.dp)) },
        colors = AssistChipDefaults.assistChipColors(
            containerColor = container,
            labelColor = content,
            leadingIconContentColor = content,
        ),
        modifier = modifier
            .heightIn(min = 48.dp)
            .semantics { contentDescription = "Permission mode: ${mode.title}" },
    )
}

/**
 * The four modes. Auto is shown as coming soon and cannot be picked: the server
 * does not accept it yet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionModeSheet(
    current: PermissionMode,
    onPick: (PermissionMode) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 24.dp)) {
            Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
                Text("Permission mode", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Applies on every device and to background tasks",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            PermissionMode.entries.forEach { mode ->
                ModeRow(
                    title = mode.title,
                    body = mode.description,
                    selected = mode == current,
                    enabled = true,
                    onClick = { onPick(mode) },
                )
            }
            ModeRow(
                title = "Auto",
                body = "Kurisu decides which calls need you.",
                selected = false,
                enabled = false,
                badge = "Coming soon",
                onClick = {},
            )
        }
    }
}

@Composable
private fun ModeRow(
    title: String,
    body: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    badge: String? = null,
) {
    val alpha = if (enabled) 1f else 0.6f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
                )
                if (badge != null) {
                    Surface(
                        color = MaterialTheme.colorScheme.tertiaryContainer,
                        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
                        shape = RoundedCornerShape(50),
                    ) {
                        Text(badge, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                    }
                }
            }
            Text(
                body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
            )
        }
        RadioButton(selected = selected, onClick = null, enabled = enabled)
    }
}
