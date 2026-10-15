package com.kurisu.assistant.ui.tasks

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.model.AssistantTask
import com.kurisu.assistant.data.model.TaskUpdate
import com.kurisu.assistant.data.model.TasksChangedEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.TaskRepository
import com.kurisu.assistant.service.CoreState
import com.kurisu.assistant.ui.assistant.apiErrorMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import javax.inject.Inject

/** One group on the Tasks screen: what its tasks are doing, and its name. */
data class TaskGroupUi(val status: String, val label: String, val tasks: List<AssistantTask>)

// A finished one-off is not here: `GET /tasks` leaves it out, and its run stays
// a conversation (#352).
private val GROUP_ORDER = listOf(
    "waiting_for_approval" to "Waiting for approval",
    "running" to "Running",
    "scheduled" to "Scheduled",
    "paused" to "Paused",
)

/** The filter chips, "all" first. */
val TASK_FILTERS: List<Pair<String, String>> = listOf("all" to "All") + GROUP_ORDER

/** Tasks in screen order, one group per status that has any, kept by [filter]. */
fun groupTasks(tasks: List<AssistantTask>, filter: String): List<TaskGroupUi> =
    GROUP_ORDER
        .filter { (status, _) -> filter == "all" || filter == status }
        .map { (status, label) -> TaskGroupUi(status, label, tasks.filter { it.status == status }) }
        .filter { it.tasks.isNotEmpty() }

private fun hhmm(at: ZonedDateTime) = "%02d:%02d".format(at.hour, at.minute)
private fun weekday(at: ZonedDateTime) = at.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)
private fun month(at: ZonedDateTime) = at.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)

/**
 * When a task next runs, as a person would say it, in local time: "today
 * 18:00", "tomorrow 07:30", "Fri 19:00" within the week, "Fri 4 Dec, 09:00"
 * beyond it. The desktop's `formatNextRun` says the same.
 */
fun formatNextRun(iso: String?, now: ZonedDateTime = ZonedDateTime.now()): String {
    if (iso.isNullOrBlank()) return ""
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    if (!instant.isAfter(now.toInstant())) return "due now"
    val at = instant.atZone(now.zone)
    val days = ChronoUnit.DAYS.between(now.toLocalDate(), at.toLocalDate())
    return when {
        days == 0L -> "today ${hhmm(at)}"
        days == 1L -> "tomorrow ${hhmm(at)}"
        days < 7L -> "${weekday(at)} ${hhmm(at)}"
        else -> "${weekday(at)} ${at.dayOfMonth} ${month(at)}, ${hhmm(at)}"
    }
}

/** When a run happened: "Today, 07:30", "Mon 12 Oct, 07:30". */
fun formatRunTime(iso: String?, now: ZonedDateTime = ZonedDateTime.now()): String {
    if (iso.isNullOrBlank()) return ""
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val at = instant.atZone(now.zone)
    return if (at.toLocalDate() == now.toLocalDate()) "Today, ${hhmm(at)}"
    else "${weekday(at)} ${at.dayOfMonth} ${month(at)}, ${hhmm(at)}"
}

/** The line under a task's title: its schedule, and what it is doing about it. */
fun taskSummary(task: AssistantTask, now: ZonedDateTime = ZonedDateTime.now()): String = when (task.status) {
    "waiting_for_approval" -> "${task.scheduleLabel} · waiting for your approval"
    "running" -> "${task.scheduleLabel} · running now"
    "paused" -> "${task.scheduleLabel} · paused"
    "finished" -> task.lastRunAt?.let { "${task.scheduleLabel} · ran ${formatRunTime(it, now)}" } ?: task.scheduleLabel
    else -> task.nextRunAt?.let { "${task.scheduleLabel} · next ${formatNextRun(it, now)}" } ?: task.scheduleLabel
}

data class TasksUiState(
    val tasks: List<AssistantTask> = emptyList(),
    val filter: String = "all",
    /** The open task, with its runs; null shows the list. */
    val selected: AssistantTask? = null,
    val isLoading: Boolean = true,
    val error: String? = null,
) {
    val groups: List<TaskGroupUi> get() = groupTasks(tasks, filter)
}

/**
 * Tasks (#352): what the assistant does on its own, now or on a schedule. The
 * assistant plans them; this lists them, opens one with its recent runs, and
 * changes, pauses, stops or deletes it. A run is a conversation: opening one
 * puts it on the chat.
 *
 * A run starts and ends with nobody watching, so the list follows the server's
 * `tasks_changed` rather than waiting to be reopened.
 */
@HiltViewModel
class TasksViewModel @Inject constructor(
    private val taskRepository: TaskRepository,
    private val wsManager: WebSocketManager,
    private val coreState: CoreState,
) : ViewModel() {

    companion object {
        private const val TAG = "TasksViewModel"
    }

    private val _state = MutableStateFlow(TasksUiState())
    val state: StateFlow<TasksUiState> = _state

    init {
        load()
        viewModelScope.launch {
            wsManager.events.collect { event ->
                if (event is TasksChangedEvent) refresh()
            }
        }
    }

    fun load() {
        viewModelScope.launch { refreshList() }
    }

    private suspend fun refreshList() {
        try {
            val tasks = taskRepository.listTasks()
            _state.update { s ->
                val gone = s.selected != null && tasks.none { it.id == s.selected.id }
                s.copy(tasks = tasks, isLoading = false, error = null, selected = if (gone) null else s.selected)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not load tasks", e)
            _state.update { it.copy(isLoading = false, error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
        }
    }

    private suspend fun refresh() {
        refreshList()
        val open = _state.value.selected?.id ?: return
        runCatching { taskRepository.getTask(open) }
            .onSuccess { task -> _state.update { s -> if (s.selected?.id == open) s.copy(selected = task) else s } }
    }

    fun setFilter(filter: String) {
        _state.update { it.copy(filter = filter) }
    }

    fun open(id: Int) {
        _state.update { s -> s.copy(selected = s.tasks.firstOrNull { it.id == id }) }
        viewModelScope.launch {
            try {
                val task = taskRepository.getTask(id)
                _state.update { s -> if (s.selected?.id == id) s.copy(selected = task) else s }
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
        }
    }

    fun close() {
        _state.update { it.copy(selected = null) }
    }

    private fun replace(task: AssistantTask) {
        _state.update { s ->
            s.copy(
                tasks = s.tasks.map { if (it.id == task.id) task.copy(runs = null) else it },
                selected = if (s.selected?.id == task.id) task else s.selected,
                error = null,
            )
        }
    }

    fun update(id: Int, update: TaskUpdate) {
        viewModelScope.launch {
            try {
                replace(taskRepository.updateTask(id, update))
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
        }
    }

    fun setPaused(id: Int, paused: Boolean) {
        viewModelScope.launch {
            try {
                replace(taskRepository.setPaused(id, paused))
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
        }
    }

    fun stop(id: Int) {
        viewModelScope.launch {
            try {
                taskRepository.stopTask(id)
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
            refresh()
        }
    }

    fun delete(id: Int) {
        viewModelScope.launch {
            try {
                taskRepository.deleteTask(id)
                _state.update { s ->
                    s.copy(
                        tasks = s.tasks.filterNot { it.id == id },
                        selected = if (s.selected?.id == id) null else s.selected,
                        error = null,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
        }
    }

    /** Approve or deny the call a run waits on (#352); the run carries on with the answer. */
    fun answerApproval(approvalId: Int, approved: Boolean) {
        viewModelScope.launch {
            try {
                taskRepository.answerApproval(approvalId, approved)
            } catch (e: Exception) {
                _state.update { it.copy(error = apiErrorMessage(e, "Could not reach the server. Try again.")) }
            }
            refresh()
        }
    }

    /** Put a run's (or the planning chat's) conversation on the chat; the caller navigates. */
    fun openConversation(conversationId: Int) {
        coreState.setConversationId(conversationId)
    }
}
