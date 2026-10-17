package com.kurisu.assistant.domain.calendar

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.CalendarEntry
import com.kurisu.assistant.di.NetworkModule
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * The calendar's date arithmetic (#282), on the JVM with the zone named.
 *
 * The server stores instants in UTC and all-day entries as dates; the phone
 * shows them in its own zone. A week starts on Monday, a timed entry is on the
 * day it starts locally, and an all-day one is on its dates wherever the phone
 * is. The desktop's `@kurisu/models` `calendar.ts` makes the same decisions.
 */
class CalendarMathTest {

    private val la = ZoneId.of("America/Los_Angeles")

    private fun entry(
        id: Int = 1,
        kind: String = "event",
        title: String = "Untitled",
        startsAt: String? = null,
        endsAt: String? = null,
        allDay: Boolean = false,
        startDate: String? = null,
        endDate: String? = null,
        done: Boolean = false,
        repeat: String? = null,
        repeatDays: List<String> = emptyList(),
    ) = CalendarEntry(
        id = id, kind = kind, title = title, allDay = allDay,
        startsAt = startsAt, endsAt = endsAt, startDate = startDate, endDate = endDate, done = done,
        repeat = repeat, repeatDays = repeatDays,
    )

    @Test
    fun `a week runs Monday to Monday in the phone's zone`() {
        val window = CalendarMath.window(CalendarView.WEEK, LocalDate.of(2026, 10, 13), la)
        assertThat(window.days.first()).isEqualTo(LocalDate.of(2026, 10, 12))
        assertThat(window.days).hasSize(7)
        // Midnight in Los Angeles (PDT, UTC-7) is 07:00 UTC.
        assertThat(window.start.toString()).isEqualTo("2026-10-12T07:00:00Z")
        assertThat(window.end.toString()).isEqualTo("2026-10-19T07:00:00Z")
    }

    @Test
    fun `a day is one local day`() {
        val window = CalendarMath.window(CalendarView.DAY, LocalDate.of(2026, 10, 13), la)
        assertThat(window.days).containsExactly(LocalDate.of(2026, 10, 13))
        assertThat(window.end.toString()).isEqualTo("2026-10-14T07:00:00Z")
    }

    @Test
    fun `timed entries are on their local day, all-day ones on their dates`() {
        // 02:00 UTC on the 17th is 19:00 on the 16th in Los Angeles.
        val call = entry(id = 1, kind = "reminder", title = "Call Mom", startsAt = "2026-10-17T02:00:00Z")
        val birthday = entry(id = 2, title = "Birthday", allDay = true, startDate = "2026-10-18", endDate = "2026-10-18")
        val trip = entry(id = 3, title = "Trip", allDay = true, startDate = "2026-10-16", endDate = "2026-10-19")
        val all = listOf(call, birthday, trip)

        assertThat(CalendarMath.onDay(all, LocalDate.of(2026, 10, 16), la).map { it.id }).containsExactly(3, 1).inOrder()
        assertThat(CalendarMath.onDay(all, LocalDate.of(2026, 10, 17), la).map { it.id }).containsExactly(3)
        assertThat(CalendarMath.onDay(all, LocalDate.of(2026, 10, 18), la).map { it.id }).containsExactly(2, 3).inOrder()
    }

    @Test
    fun `the time reads the way the calendar shows it`() {
        val lunch = entry(startsAt = "2026-10-13T19:00:00Z", endsAt = "2026-10-13T20:00:00Z")
        assertThat(CalendarMath.describeWhen(lunch, la)).isEqualTo("12:00 – 13:00")
        assertThat(CalendarMath.describeWhen(entry(kind = "reminder", startsAt = "2026-10-17T02:00:00Z"), la)).isEqualTo("19:00")
        assertThat(CalendarMath.describeWhen(entry(allDay = true, startDate = "2026-10-18", endDate = "2026-10-18"), la)).isEqualTo("All day")
    }

    @Test
    fun `the header names the window`() {
        assertThat(CalendarMath.title(CalendarView.WEEK, LocalDate.of(2026, 10, 13))).isEqualTo("12 – 18 October 2026")
        assertThat(CalendarMath.title(CalendarView.WEEK, LocalDate.of(2026, 10, 29))).isEqualTo("26 October – 1 November 2026")
        assertThat(CalendarMath.title(CalendarView.DAY, LocalDate.of(2026, 10, 13))).isEqualTo("Tuesday 13 October 2026")
    }

    @Test
    fun `a calendar tool's answer becomes the chat card`() {
        val json = NetworkModule.provideJson()
        val created = """
            {"summary": "Added the reminder “Call Mom” on Fri 16 Oct 2026, 19:00 (America/Los_Angeles).",
             "entry": {"id": 42, "kind": "reminder", "title": "Call Mom", "notes": null, "all_day": false,
                       "starts_at": "2026-10-17T02:00:00Z", "ends_at": null, "start_date": null, "end_date": null,
                       "done": false, "done_at": null, "created_at": null, "updated_at": null},
             "time_zone": "America/Los_Angeles"}
        """.trimIndent()

        val card = CalendarMath.toolCard("calendar_create", created, json)!!
        assertThat(card.action).isEqualTo(CalendarToolAction.CREATED)
        assertThat(card.entry!!.id).isEqualTo(42)
        assertThat(card.entry!!.title).isEqualTo("Call Mom")
        assertThat(CalendarMath.toolCard("calendar_move", created, json)!!.action).isEqualTo(CalendarToolAction.MOVED)

        assertThat(CalendarMath.toolCard("calendar_create", """{"error": "A reminder needs a date and a time."}""", json)).isNull()
        assertThat(CalendarMath.toolCard("calendar_list", "On the calendar from …", json)).isNull()
        assertThat(CalendarMath.toolCard("drive_write", created, json)).isNull()
    }

    @Test
    fun `a repeat in words (#355)`() {
        assertThat(CalendarMath.describeRepeat(entry(kind = "reminder", repeat = "daily"))).isEqualTo("Every day")
        assertThat(CalendarMath.describeRepeat(entry(kind = "reminder", repeat = "weekdays"))).isEqualTo("Every weekday")
        assertThat(CalendarMath.describeRepeat(entry(kind = "reminder", repeat = "weekly", repeatDays = listOf("mon", "thu"))))
            .isEqualTo("Every Monday and Thursday")
        assertThat(CalendarMath.describeRepeat(entry(kind = "reminder", repeat = "weekly", repeatDays = listOf("mon", "wed", "fri"))))
            .isEqualTo("Every Monday, Wednesday and Friday")
        assertThat(CalendarMath.describeRepeat(entry(kind = "reminder"))).isNull()
    }

    @Test
    fun `each time of a repeating reminder has a key of its own (#355)`() {
        val friday = entry(id = 7, kind = "reminder", repeat = "daily", startsAt = "2026-10-16T15:00:00Z")
        val saturday = friday.copy(startsAt = "2026-10-17T15:00:00Z")
        assertThat(CalendarMath.entryKey(friday)).isNotEqualTo(CalendarMath.entryKey(saturday))
        assertThat(CalendarMath.entryKey(entry(id = 9, allDay = true, startDate = "2026-10-18"))).isEqualTo("9@2026-10-18")
        assertThat(CalendarMath.onDay(listOf(friday, saturday), LocalDate.of(2026, 10, 17), la)).containsExactly(saturday)
    }

    @Test
    fun `what calendar_repeat answered is a change (#355)`() {
        val json = NetworkModule.provideJson()
        val changed = """
            {"summary": "The reminder “Take the pills” now repeats every day at 08:00, from Fri 16 Oct 2026 (UTC).",
             "entry": {"id": 42, "kind": "reminder", "title": "Take the pills", "all_day": false,
                       "starts_at": "2026-10-16T08:00:00Z", "repeat": "daily", "repeat_days": [],
                       "repeat_from": "2026-10-16T08:00:00Z"},
             "time_zone": "UTC"}
        """.trimIndent()
        assertThat(CalendarMath.toolCard("calendar_repeat", changed, json)!!.action).isEqualTo(CalendarToolAction.CHANGED)
    }
}
