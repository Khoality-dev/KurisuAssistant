package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.di.NetworkModule
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
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

    @Test
    fun `a repeating reminder decodes with its repeat (#355)`() {
        val entry = json.decodeFromString(
            CalendarEntry.serializer(),
            """{"id": 11, "kind": "reminder", "title": "Bins out", "notes": null, "all_day": false,
                "starts_at": "2026-10-19T02:00:00Z", "ends_at": null, "start_date": null, "end_date": null,
                "done": false, "done_at": null, "repeat": "weekly", "repeat_days": ["mon", "thu"],
                "repeat_from": "2026-10-16T02:00:00Z", "created_at": null, "updated_at": null}""",
        )
        assertThat(entry.repeat).isEqualTo("weekly")
        assertThat(entry.repeatDays).containsExactly("mon", "thu").inOrder()
        assertThat(entry.repeatFrom).isEqualTo("2026-10-16T02:00:00Z")
        assertThat(entry.isRepeating).isTrue()
        // An entry from before #355 has none of it.
        assertThat(CalendarEntry(id = 1, kind = "reminder", title = "Once").isRepeating).isFalse()
    }

    @Test
    fun `stopping a repeat sends an explicit null and nothing else it did not change (#355)`() {
        val body = json.encodeToJsonElement(
            CalendarEntryUpdate.serializer(),
            CalendarEntryUpdate(title = "Take the pills", repeat = CalendarEntryUpdate.repeat(null)),
        ) as JsonObject
        assertThat(body.keys).containsExactly("title", "repeat")
        assertThat(body["repeat"]).isEqualTo(JsonNull)

        val weekly = json.encodeToJsonElement(
            CalendarEntryUpdate.serializer(),
            CalendarEntryUpdate(repeat = CalendarEntryUpdate.repeat("weekly"), repeatDays = listOf("wed")),
        ) as JsonObject
        assertThat(weekly["repeat"]!!.jsonPrimitive.content).isEqualTo("weekly")
        assertThat(weekly["repeat_days"]!!.jsonArray.map { it.jsonPrimitive.content }).containsExactly("wed")
    }

    @Test
    fun `done on one time names the time (#355)`() {
        val body = json.encodeToJsonElement(
            CalendarEntryUpdate.serializer(),
            CalendarEntryUpdate(done = true, occurrenceAt = "2026-10-17T15:00:00Z"),
        ) as JsonObject
        assertThat(body.keys).containsExactly("done", "occurrence_at")
    }

    @Test
    fun `a new reminder can carry its repeat (#355)`() {
        val body = json.encodeToJsonElement(
            CalendarEntryCreate.serializer(),
            CalendarEntryCreate(kind = "reminder", title = "Bins out", startsAt = "2026-10-19T02:00:00Z", repeat = "weekly", repeatDays = listOf("mon")),
        ) as JsonObject
        assertThat(body.keys).containsExactly("kind", "title", "starts_at", "repeat", "repeat_days")
    }
}
