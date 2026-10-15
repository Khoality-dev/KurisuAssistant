package com.kurisu.assistant.e2e

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tasks (#352) on the `tasks` mock: a running, a scheduled and a paused task,
 * runs to open, and a reply that schedules a task in the chat. The mock keeps
 * its state for the whole run, so a test that pauses a task resumes it.
 */
@RunWith(AndroidJUnit4::class)
class TasksScreenTest : E2eTest() {
    override val scenario = "tasks"

    private fun openTasks() {
        openDrawerItem("Tasks")
        waitForText("Morning briefing")
    }

    private fun taskStatus(id: Int): String? =
        mock.getJson("/tasks/$id").jsonObject["status"]?.jsonPrimitive?.content

    @Test
    fun tasks_are_grouped_by_what_they_are_doing() {
        login()
        openTasks()
        waitForText("Gather everything about the apartment move")
        waitForText("Weekly French recap")
        waitForText("RUNNING")
        waitForText("SCHEDULED")
        waitForText("Weekdays at 07:30", substring = true)
    }

    @Test
    fun a_task_opens_with_its_instructions_and_runs() {
        login()
        openTasks()
        composeRule.onNodeWithTag("task-row-2").performClick()
        waitForText("Task instructions")
        waitForText("Weather and today's calendar, three lines at most.")
        waitForText("needed approval", substring = true)
    }

    @Test
    fun a_run_opens_its_conversation() {
        login()
        openTasks()
        composeRule.onNodeWithTag("task-row-2").performClick()
        waitForText("Task instructions")
        composeRule.onNodeWithTag("task-run-21").performClick()
        waitUntilViewShows("Sunny, 14° to 19°")
    }

    @Test
    fun pausing_and_resuming_reach_the_server() {
        login()
        openTasks()
        composeRule.onNodeWithTag("task-row-2").performClick()
        waitForText("Task instructions")

        composeRule.onNode(hasText("Pause") and hasClickAction()).performClick()
        assertTrue("paused on the server", waitUntilTrue { taskStatus(2) == "paused" })

        composeRule.onNode(hasText("Resume") and hasClickAction()).performClick()
        assertTrue("resumed on the server", waitUntilTrue { taskStatus(2) == "scheduled" })
    }

    @Test
    fun a_run_waiting_for_approval_is_approved_from_tasks() {
        login()
        openTasks()
        waitForText("WAITING FOR APPROVAL")
        composeRule.onNodeWithTag("task-row-5").performClick()
        waitForText("Waiting for your approval")
        waitForText("drive_write")
        composeRule.onNode(hasText("Approve") and hasClickAction()).performClick()
        assertTrue("approved on the server", waitUntilTrue { taskStatus(5) == "running" })
    }

    @Test
    fun the_account_time_zone_is_filled_from_the_phone() {
        login()
        openTasks()
        val zone = java.time.ZoneId.systemDefault().id
        assertTrue(
            "the account's zone is this phone's",
            waitUntilTrue { mock.getJson("/users/me").jsonObject["timezone"]?.jsonPrimitive?.content == zone },
        )
    }

    @Test
    fun a_task_the_assistant_schedules_is_a_card_in_the_chat() {
        login()
        openChat()
        send("Check flight prices to Hanoi every morning")
        waitForText("Task scheduled")
        waitForText("Every day at 08:00", substring = true)
        composeRule.onNode(hasText("Open in Tasks") and hasClickAction()).performClick()
        waitForText("Morning briefing")
    }
}
