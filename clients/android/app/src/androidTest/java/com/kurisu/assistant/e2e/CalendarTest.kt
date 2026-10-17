package com.kurisu.assistant.e2e

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.time.LocalDate
import java.time.ZoneId

/**
 * The calendar (#282) against the mock: the drawer's Calendar opens on today,
 * what the server holds is on it, and Done reaches the server — for a reminder
 * that repeats (#355), Done for today's time alone.
 */
@RunWith(AndroidJUnit4::class)
class CalendarTest : E2eTest() {

    /** A reminder at noon today in the phone's zone, put on the mock directly. */
    private fun seedReminder(title: String): Int {
        val zone = ZoneId.systemDefault()
        val noon = LocalDate.now(zone).atTime(12, 0).atZone(zone).toInstant()
        val made = mock.post("/calendar/entries", """{"kind": "reminder", "title": "$title", "starts_at": "$noon"}""")
        return kotlinx.serialization.json.Json.parseToJsonElement(made).jsonObject["id"]!!.jsonPrimitive.int
    }

    @Test
    fun todays_reminder_is_on_the_calendar_and_done_reaches_the_server() {
        val title = unique("Call Mom")
        val id = seedReminder(title)

        login()
        openDrawerItem("Calendar")
        waitForText(title)

        composeRule.onNodeWithText(title, useUnmergedTree = true).performClick()
        waitForText("Done")
        composeRule.onNode(hasText("Done") and hasClickAction()).performClick()

        assertTrue("the reminder is done on the server", waitUntilTrue {
            mock.getJson("/calendar/entries/$id").jsonObject["done"]!!.jsonPrimitive.boolean
        })
    }

    @Test
    fun a_repeating_reminder_is_on_today_and_done_is_for_todays_time() {
        val title = unique("Take the pills")
        val zone = ZoneId.systemDefault()
        val since = LocalDate.now(zone).minusDays(3).atTime(12, 0).atZone(zone).toInstant()
        val made = mock.post(
            "/calendar/entries",
            """{"kind": "reminder", "title": "$title", "starts_at": "$since", "repeat": "daily"}""",
        )
        val id = kotlinx.serialization.json.Json.parseToJsonElement(made).jsonObject["id"]!!.jsonPrimitive.int
        val today = LocalDate.now(zone).atTime(12, 0).atZone(zone).toInstant().toString()

        login()
        openDrawerItem("Calendar")
        waitForText(title)

        // Today's row comes first; its next times are under "Coming up" below.
        composeRule.onAllNodesWithText(title, useUnmergedTree = true)[0].performClick()
        waitForText("Done")
        waitForText("Every day")
        composeRule.onNode(hasText("Done") and hasClickAction()).performClick()

        // The entry on its own is today's time; that one is done, and only that one.
        assertTrue("today's time is done on the server", waitUntilTrue {
            val entry = mock.getJson("/calendar/entries/$id").jsonObject
            entry["starts_at"]!!.jsonPrimitive.content == today && entry["done"]!!.jsonPrimitive.boolean
        })
    }
}
