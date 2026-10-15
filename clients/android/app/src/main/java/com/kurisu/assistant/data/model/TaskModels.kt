package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Tasks (#352): work the assistant does on its own, now or on a schedule.
 *
 * Mirrors `tasks/records.py::task_dict` in the backend — one shape for
 * `GET /tasks`, `GET /tasks/{id}` (which adds [runs]) and the task tools'
 * results the chat shows as cards.
 */
@Serializable
data class AssistantTask(
    val id: Int,
    val title: String,
    /** What the assistant does each run: the opening message of every run. */
    val instructions: String = "",
    /**
     * `waiting_for_approval`, `running`, `scheduled`, `paused` or `finished`.
     * `GET /tasks` leaves `finished` one-offs out (#352).
     */
    val status: String = "scheduled",
    /** `now`, `once`, `daily`, `weekdays`, `weekly` or `hourly`. */
    val repeat: String = "now",
    val timezone: String = "UTC",
    @SerialName("run_at") val runAt: String? = null,
    val time: String? = null,
    val days: List<String> = emptyList(),
    @SerialName("every_hours") val everyHours: Int? = null,
    /** The schedule in a few words, made by the server ("Weekdays at 07:30"). */
    @SerialName("schedule_label") val scheduleLabel: String = "",
    @SerialName("next_run_at") val nextRunAt: String? = null,
    @SerialName("last_run_at") val lastRunAt: String? = null,
    @SerialName("planned_in_conversation_id") val plannedInConversationId: Int? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    /** The call the running task waits on the user to approve, when it waits. */
    @SerialName("pending_approval") val pendingApproval: TaskApproval? = null,
    /** On `GET /tasks/{id}` only: the ten newest runs, newest first. */
    val runs: List<TaskRun>? = null,
)

/** A tool call a task run waits on the user to approve (#352). */
@Serializable
data class TaskApproval(
    val id: Int,
    @SerialName("run_id") val runId: Int = 0,
    @SerialName("task_id") val taskId: Int? = null,
    @SerialName("task_title") val taskTitle: String = "",
    /** The run's conversation, where it is answered too. */
    @SerialName("conversation_id") val conversationId: Int? = null,
    @SerialName("tool_name") val toolName: String,
    @SerialName("tool_args") val toolArgs: JsonObject = JsonObject(emptyMap()),
    val description: String = "",
    val status: String = "pending",
    @SerialName("requested_at") val requestedAt: String? = null,
    /** Nobody answering by then denies the call. */
    @SerialName("expires_at") val expiresAt: String? = null,
)

@Serializable
data class ApprovalAnswer(
    val approved: Boolean,
    @SerialName("modified_args") val modifiedArgs: JsonObject? = null,
)

@Serializable
data class TaskRun(
    val id: Int,
    /** `running`, `waiting_for_approval`, `done`, `failed` or `stopped`. */
    val status: String,
    /** Why a run failed, in words to show as they are. */
    val error: String? = null,
    /** The conversation the run wrote; open it to see what the assistant did. */
    @SerialName("conversation_id") val conversationId: Int? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
)

@Serializable
data class TaskScheduleUpdate(
    val repeat: String,
    val timezone: String? = null,
    val at: String? = null,
    val time: String? = null,
    val days: List<String>? = null,
    @SerialName("every_hours") val everyHours: Int? = null,
)

/** `PATCH /tasks/{id}`. A null field is left out of the body, and left alone. */
@Serializable
data class TaskUpdate(
    val title: String? = null,
    val instructions: String? = null,
    val paused: Boolean? = null,
    val schedule: TaskScheduleUpdate? = null,
)

/** What a task tool answered, as the chat shows it in a card. */
@Serializable
data class TaskToolResult(
    /** `started`, `scheduled`, `updated`, `stopped`, `not_running` or `deleted`. */
    val action: String,
    val task: AssistantTask,
)

/** The tools that answer with a task; `task_list` answers with a list and stays a tool row. */
val TASK_CARD_TOOLS = setOf("task_start", "task_schedule", "task_update", "task_stop", "task_delete")

private val TASK_ACTIONS = setOf("started", "scheduled", "updated", "stopped", "not_running", "deleted")
private val taskJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * A task tool's result, or null when the tool message is anything else and
 * should stay an ordinary tool row: another tool, an error, a cut-off stream.
 */
fun parseTaskToolResult(toolName: String?, content: String?): TaskToolResult? {
    if (toolName == null || toolName !in TASK_CARD_TOOLS || content.isNullOrBlank()) return null
    return runCatching { taskJson.decodeFromString<TaskToolResult>(content) }
        .getOrNull()
        ?.takeIf { it.action in TASK_ACTIONS }
}
