package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import org.junit.Test

/**
 * Tasks (#352) as the backend sends them, and a task tool's result as the chat
 * reads it. Anything that is not a task tool's answer stays a tool row, so the
 * parser has to say no rather than guess.
 */
class TaskModelsTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val taskJson = """
        {"id": 2, "title": "Morning briefing", "instructions": "Weather and calendar.",
         "status": "scheduled", "repeat": "weekdays", "timezone": "Europe/Paris",
         "run_at": null, "time": "07:30", "days": [], "every_hours": null,
         "schedule_label": "Weekdays at 07:30 (Europe/Paris)",
         "next_run_at": "2026-10-14T05:30:00Z", "last_run_at": null,
         "planned_in_conversation_id": 9, "created_at": "2026-10-13T12:00:00Z",
         "updated_at": "2026-10-13T12:00:00Z",
         "runs": [{"id": 5, "status": "failed", "error": "history_list needed approval",
                   "conversation_id": 12, "started_at": "2026-10-13T05:30:00Z",
                   "finished_at": "2026-10-13T05:30:04Z"}]}
    """.trimIndent()

    @Test
    fun `a task decodes as the backend serves it`() {
        val task = json.decodeFromString<AssistantTask>(taskJson)
        assertThat(task.scheduleLabel).isEqualTo("Weekdays at 07:30 (Europe/Paris)")
        assertThat(task.plannedInConversationId).isEqualTo(9)
        assertThat(task.runs!!.single().error).contains("approval")
        assertThat(task.runs!!.single().conversationId).isEqualTo(12)
    }

    @Test
    fun `a task waiting for approval carries the call`() {
        val task = json.decodeFromString<AssistantTask>(
            """{"id": 5, "title": "Tidy", "status": "waiting_for_approval",
                "pending_approval": {"id": 9, "run_id": 51, "task_id": 5, "task_title": "Tidy",
                  "conversation_id": 2, "tool_name": "drive_write", "tool_args": {"path": "/a"},
                  "description": "Write /a", "status": "pending",
                  "requested_at": "2026-10-13T10:00:00Z", "expires_at": "2026-10-14T10:00:00Z"}}""",
        )
        val approval = task.pendingApproval!!
        assertThat(approval.toolName).isEqualTo("drive_write")
        assertThat(approval.conversationId).isEqualTo(2)
        assertThat(approval.toolArgs.toString()).contains("/a")
    }

    @Test
    fun `a conversation a task run wrote says so`() {
        val conv = json.decodeFromString<Conversation>(
            """{"id": 12, "title": "Morning briefing", "task_run": true, "task_id": 2}""",
        )
        assertThat(conv.taskRun).isTrue()
        assertThat(conv.taskId).isEqualTo(2)
        assertThat(json.decodeFromString<Conversation>("""{"id": 1}""").taskRun).isFalse()
    }

    @Test
    fun `a task tool's answer is a card`() {
        val result = parseTaskToolResult("task_schedule", """{"action": "scheduled", "task": $taskJson}""")
        assertThat(result?.action).isEqualTo("scheduled")
        assertThat(result?.task?.title).isEqualTo("Morning briefing")
    }

    @Test
    fun `anything else stays a tool row`() {
        assertThat(parseTaskToolResult("history_list", """{"action": "scheduled", "task": $taskJson}""")).isNull()
        assertThat(parseTaskToolResult("task_schedule", """{"error": "bad time"}""")).isNull()
        assertThat(parseTaskToolResult("task_list", """{"tasks": [$taskJson]}""")).isNull()
        assertThat(parseTaskToolResult("task_start", """{"action": "sta""")).isNull()
        assertThat(parseTaskToolResult(null, """{"action": "started", "task": $taskJson}""")).isNull()
    }
}
