package com.kurisu.assistant.ui.tasks

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.Update
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.AssistantTask
import com.kurisu.assistant.data.model.TaskRun
import com.kurisu.assistant.data.model.TaskUpdate

/**
 * Tasks (#352): the assistant's own work, running now or on a schedule.
 *
 * The list is grouped by what each task is doing, with a filter over the
 * groups; a task opens in place with its instructions, schedule and recent
 * runs, and system back closes it. A run is a conversation: [onOpenChat] is
 * called once its id is on the chat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    onOpenMenu: (() -> Unit)? = null,
    /** A task to open straight away: a task card's "Open in Tasks". */
    openTaskId: Int? = null,
    onOpenChat: () -> Unit,
    viewModel: TasksViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val selected = state.selected

    LaunchedEffect(openTaskId) { openTaskId?.let(viewModel::open) }

    BackHandler(enabled = selected != null) { viewModel.close() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (selected == null) "Tasks" else selected.title, maxLines = 1) },
                navigationIcon = {
                    if (selected != null) {
                        IconButton(onClick = viewModel::close) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to tasks")
                        }
                    } else if (onOpenMenu != null) {
                        IconButton(onClick = onOpenMenu) { Icon(Icons.Outlined.Menu, contentDescription = "Menu") }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            if (selected == null) {
                TaskList(state, viewModel)
            } else {
                TaskDetail(
                    task = selected,
                    error = state.error,
                    viewModel = viewModel,
                    onOpenConversation = { id ->
                        viewModel.openConversation(id)
                        onOpenChat()
                    },
                )
            }
        }
    }
}

private data class TaskLook(val icon: ImageVector, val bg: Color, val fg: Color)

private fun lookFor(task: AssistantTask): TaskLook = when {
    task.status == "waiting_for_approval" -> TaskLook(Icons.Outlined.HourglassTop, Color(0xFFFFFBEB), Color(0xFF92400E))
    task.status == "running" -> TaskLook(Icons.Outlined.Autorenew, Color(0xFFF0FDF4), Color(0xFF166534))
    task.status == "paused" -> TaskLook(Icons.Outlined.PauseCircle, Color(0xFFF5F5F5), Color(0xFF737373))
    task.status == "finished" -> TaskLook(Icons.Outlined.TaskAlt, Color(0xFFF5F5F5), Color(0xFF737373))
    task.repeat == "once" || task.repeat == "now" -> TaskLook(Icons.Outlined.EventAvailable, Color(0xFFEFF6FF), Color(0xFF1D4ED8))
    else -> TaskLook(Icons.Outlined.Repeat, Color(0xFFEFF6FF), Color(0xFF1D4ED8))
}

@Composable
private fun TaskList(state: TasksUiState, viewModel: TasksViewModel) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("tasks-list"),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
    ) {
        item {
            Text(
                "Work the assistant does on its own. Ask the assistant to start or schedule one. " +
                    "Reminders for you are in the calendar.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TASK_FILTERS.forEach { (id, label) ->
                    val count = if (id == "all") state.tasks.size else state.tasks.count { it.status == id }
                    FilterChip(
                        selected = state.filter == id,
                        onClick = { viewModel.setFilter(id) },
                        label = { Text("$label $count") },
                    )
                }
            }
        }
        state.error?.let { message ->
            item { Text(message, color = MaterialTheme.colorScheme.error) }
        }
        if (!state.isLoading && state.tasks.isEmpty()) {
            item {
                Text(
                    "No tasks yet. Ask the assistant to do something in the background or on a schedule.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
            }
        }
        items(state.groups, key = { it.status }) { group ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("task-group-${group.status}")) {
                Text(
                    group.label.uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    tonalElevation = 1.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column {
                        group.tasks.forEach { task -> TaskRow(task) { viewModel.open(task.id) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: AssistantTask, onClick: () -> Unit) {
    val look = lookFor(task)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("task-row-${task.id}")
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(40.dp).background(look.bg, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) { Icon(look.icon, contentDescription = null, tint = look.fg) }
        Column(Modifier.weight(1f)) {
            Text(task.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(taskSummary(task), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun Detail(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun TaskDetail(
    task: AssistantTask,
    error: String?,
    viewModel: TasksViewModel,
    onOpenConversation: (Int) -> Unit,
) {
    var editing by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val statusLabel = mapOf(
        "waiting_for_approval" to "Waiting for approval", "running" to "Running",
        "scheduled" to "Scheduled", "paused" to "Paused", "finished" to "Finished",
    )

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("task-detail"),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Text(statusLabel[task.status] ?: task.status, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }
        task.pendingApproval?.let { approval ->
            item {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = Color(0xFFFFFBEB),
                    modifier = Modifier.fillMaxWidth().testTag("task-pending-approval"),
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.HourglassTop, contentDescription = null, tint = Color(0xFF92400E), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Waiting for your approval", color = Color(0xFF78350F), fontWeight = FontWeight.SemiBold)
                        }
                        Text(approval.toolName, color = Color(0xFF78350F), fontWeight = FontWeight.SemiBold)
                        if (approval.description.isNotBlank()) {
                            Text(approval.description, color = Color(0xFF78350F), style = MaterialTheme.typography.bodySmall)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                            OutlinedButton(onClick = { viewModel.answerApproval(approval.id, approved = true) }) {
                                Icon(Icons.Outlined.Check, contentDescription = null); Spacer(Modifier.width(6.dp)); Text("Approve")
                            }
                            TextButton(onClick = { viewModel.answerApproval(approval.id, approved = false) }) {
                                Icon(Icons.Outlined.Block, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                                Spacer(Modifier.width(6.dp))
                                Text("Deny", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
        item { Detail(Icons.Outlined.Repeat, task.scheduleLabel) }
        task.nextRunAt?.let { next -> item { Detail(Icons.Outlined.Update, "Next run ${formatNextRun(next)}") } }
        task.plannedInConversationId?.let { conversationId ->
            item {
                TextButton(onClick = { onOpenConversation(conversationId) }) {
                    Icon(Icons.Outlined.Forum, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("The chat it was planned in")
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Task instructions", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Surface(shape = RoundedCornerShape(10.dp), tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
                    Text(task.instructions, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
                }
            }
        }
        error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (task.status) {
                    "running", "waiting_for_approval" -> OutlinedButton(onClick = { viewModel.stop(task.id) }) {
                        Icon(Icons.Outlined.StopCircle, contentDescription = null); Spacer(Modifier.width(6.dp)); Text("Stop")
                    }
                    "scheduled" -> OutlinedButton(onClick = { viewModel.setPaused(task.id, true) }) {
                        Icon(Icons.Outlined.Pause, contentDescription = null); Spacer(Modifier.width(6.dp)); Text("Pause")
                    }
                    "paused" -> OutlinedButton(onClick = { viewModel.setPaused(task.id, false) }) {
                        Icon(Icons.Outlined.PlayArrow, contentDescription = null); Spacer(Modifier.width(6.dp)); Text("Resume")
                    }
                }
                OutlinedButton(onClick = { editing = true }) {
                    Icon(Icons.Outlined.Edit, contentDescription = null); Spacer(Modifier.width(6.dp)); Text("Edit")
                }
                TextButton(onClick = { confirmDelete = true }) {
                    Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(6.dp))
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            }
        }
        item {
            Text("RECENT RUNS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val runs = task.runs.orEmpty()
        if (runs.isEmpty()) {
            item { Text("No runs yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        items(runs, key = { it.id }) { run -> RunRow(run, onOpenConversation) }
        item {
            Text(
                "Each run is a conversation. Open one to see what the assistant did.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (editing) {
        TaskEditDialog(task, onDismiss = { editing = false }) { title, instructions ->
            editing = false
            viewModel.update(task.id, TaskUpdate(title = title, instructions = instructions))
        }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete “${task.title}”?") },
            text = { Text((if (task.status == "running") "Its run is stopped first. " else "") + "The conversations its runs left stay.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; viewModel.delete(task.id) }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun RunRow(run: TaskRun, onOpenConversation: (Int) -> Unit) {
    val (icon, tint, label) = when (run.status) {
        "waiting_for_approval" -> Triple(Icons.Outlined.HourglassTop, Color(0xFF92400E), "Waiting for your approval")
        "running" -> Triple(Icons.Outlined.Autorenew, Color(0xFF166534), "Running")
        "done" -> Triple(Icons.Outlined.CheckCircle, Color(0xFF16A34A), "Done")
        "failed" -> Triple(Icons.Outlined.ErrorOutline, Color(0xFFDC2626), "Failed")
        else -> Triple(Icons.Outlined.StopCircle, Color(0xFF737373), "Stopped")
    }
    val conversationId = run.conversationId
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (conversationId != null) Modifier.clickable { onOpenConversation(conversationId) } else Modifier)
            .testTag("task-run-${run.id}")
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Column(Modifier.weight(1f)) {
            Text(formatRunTime(run.startedAt), style = MaterialTheme.typography.titleSmall)
            Text(
                if (run.status == "failed" && run.error != null) "Failed: ${run.error}" else label,
                style = MaterialTheme.typography.bodySmall,
                color = if (run.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (conversationId != null) {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
        }
    }
}

/** Title and instructions; a schedule is changed by asking the assistant, or on the desktop. */
@Composable
private fun TaskEditDialog(task: AssistantTask, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
    var title by remember { mutableStateOf(task.title) }
    var instructions by remember { mutableStateOf(task.instructions) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit task") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true)
                OutlinedTextField(value = instructions, onValueChange = { instructions = it }, label = { Text("Task instructions") }, minLines = 3)
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank() && instructions.isNotBlank(), onClick = { onSave(title.trim(), instructions.trim()) }) {
                Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
