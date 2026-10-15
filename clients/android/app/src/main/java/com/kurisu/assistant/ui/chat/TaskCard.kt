package com.kurisu.assistant.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.data.model.TaskToolResult
import com.kurisu.assistant.ui.tasks.formatNextRun

private data class CardLook(val heading: String, val icon: ImageVector, val bg: Color, val fg: Color)

private fun lookFor(action: String) = when (action) {
    "started" -> CardLook("Running in the background", Icons.Outlined.Autorenew, Color(0xFFF0FDF4), Color(0xFF166534))
    "scheduled" -> CardLook("Task scheduled", Icons.Outlined.Schedule, Color(0xFFEFF6FF), Color(0xFF1D4ED8))
    "updated" -> CardLook("Task changed", Icons.Outlined.Edit, Color(0xFFEFF6FF), Color(0xFF1D4ED8))
    "deleted" -> CardLook("Task deleted", Icons.Outlined.Delete, Color(0xFFF5F5F5), Color(0xFF525252))
    "not_running" -> CardLook("Task not running", Icons.Outlined.StopCircle, Color(0xFFF5F5F5), Color(0xFF525252))
    else -> CardLook("Task stopped", Icons.Outlined.StopCircle, Color(0xFFF5F5F5), Color(0xFF525252))
}

/**
 * A task tool's result in the chat (#352): what the assistant just started or
 * scheduled, as a card instead of a tool rail, with the way into Tasks. The
 * desktop's `TaskResultCard` shows the same.
 */
@Composable
fun TaskCard(result: TaskToolResult, onOpenTask: ((Int) -> Unit)?, modifier: Modifier = Modifier) {
    val task = result.task
    val look = lookFor(result.action)
    val details = buildList {
        add(if (result.action == "started") "Keeps going if you close the app" else task.scheduleLabel)
        if (result.action != "deleted" && task.status == "scheduled" && task.nextRunAt != null) {
            add("next run ${formatNextRun(task.nextRunAt)}")
        }
    }
    Surface(
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 1.dp,
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("task-card-${task.id}"),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().background(look.bg).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(look.icon, contentDescription = null, tint = look.fg, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(look.heading, color = look.fg, style = MaterialTheme.typography.labelLarge)
            }
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(task.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (result.action != "deleted" && onOpenTask != null) {
                    OutlinedButton(onClick = { onOpenTask(task.id) }, modifier = Modifier.padding(top = 6.dp)) {
                        Icon(Icons.Outlined.TaskAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Open in Tasks")
                    }
                }
            }
        }
    }
}
