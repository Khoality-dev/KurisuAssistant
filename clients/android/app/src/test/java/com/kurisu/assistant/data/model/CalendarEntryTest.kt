package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.di.NetworkModule
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * The calendar's wire shapes (#282), against the app's real `Json`.
 *
 * An entry decodes as the backend writes it, and a PATCH stays partial: the
 * route reads `model_fields_set`, so an explicit `null` title would be refused
 * and an explicit `null` start would unschedule a reminder.
 */
class CalendarEntryTest {

    private val json = NetworkModule.provideJson()

    @Test
    fun `an entry decodes as the backend writes it`() {
        val entry = json.decodeFromString(
            CalendarEntry.serializer(),
            """{"id": 9, "kind": "event", "title": "Linh's birthday", "notes": null, "all_day": true,
                "starts_at": null, "ends_at": null, "start_date": "2026-10-18", "end_date": "2026-10-18",
                "done": false, "done_at": null, "created_at": "2026-10-13T22:00:00Z", "updated_at": "2026-10-13T22:00:00Z"}""",
        )
        assertThat(entry.allDay).isTrue()
        assertThat(entry.startDate).isEqualTo("2026-10-18")
        assertThat(entry.isReminder).isFalse()
    }

    @Test
    fun `a patch carries only what changed`() {
        val body = json.encodeToJsonElement(CalendarEntryUpdate.serializer(), CalendarEntryUpdate(done = true)) as JsonObject
        assertThat(body.keys).containsExactly("done")

        val moved = json.encodeToJsonElement(
            CalendarEntryUpdate.serializer(), CalendarEntryUpdate(startsAt = "2026-10-18T02:00:00Z"),
        ) as JsonObject
        assertThat(moved.keys).containsExactly("starts_at")
        assertThat(moved["starts_at"]!!.jsonPrimitive.content).isEqualTo("2026-10-18T02:00:00Z")
    }

    @Test
    fun `a create leaves out what it does not set`() {
        val body = json.encodeToJsonElement(
            CalendarEntryCreate.serializer(),
            CalendarEntryCreate(kind = "reminder", title = "Call Mom", startsAt = "2026-10-17T02:00:00Z"),
        ) as JsonObject
        assertThat(body.keys).containsExactly("kind", "title", "starts_at")
    }

}
