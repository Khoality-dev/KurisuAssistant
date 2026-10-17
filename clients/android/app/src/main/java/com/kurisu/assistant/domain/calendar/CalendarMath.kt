package com.kurisu.assistant.domain.calendar

import com.kurisu.assistant.data.model.CalendarEntry
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

enum class CalendarView { DAY, WEEK }

/** What a view shows: its days, and the window to ask the server for. */
data class CalendarWindow(val start: Instant, val end: Instant, val days: List<LocalDate>)

enum class CalendarToolAction { CREATED, MOVED, CHANGED, DELETED }

@Serializable
data class DeletedEntry(val id: Int, val kind: String, val title: String)

/** A calendar tool's answer, as the chat card draws it. */
data class CalendarToolCard(
    val action: CalendarToolAction,
    val summary: String,
    val entry: CalendarEntry? = null,
    val deleted: DeletedEntry? = null,
)

@Serializable
private data class ToolAnswer(
    val summary: String? = null,
    val entry: CalendarEntry? = null,
    val deleted: DeletedEntry? = null,
    @SerialName("time_zone") val timeZone: String? = null,
)

/**
 * The calendar's date arithmetic (#282), with the zone always named.
 *
 * The server stores instants in UTC and all-day entries as dates; the phone
 * shows them in its own zone. A week starts on Monday, a timed entry is on the
 * local day it starts (and every later day it runs into), and an all-day one on
 * its dates wherever the phone is. The desktop's `@kurisu/models` `calendar.ts`
 * makes the same decisions.
 */
object CalendarMath {
    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    fun weekStart(day: LocalDate): LocalDate {
        val sinceMonday = (day.dayOfWeek.value - DayOfWeek.MONDAY.value + 7) % 7
        return day.minusDays(sinceMonday.toLong())
    }

    fun window(view: CalendarView, anchor: LocalDate, zone: ZoneId): CalendarWindow {
        val first = if (view == CalendarView.WEEK) weekStart(anchor) else anchor
        val count = if (view == CalendarView.WEEK) 7 else 1
        val days = (0 until count).map { first.plusDays(it.toLong()) }
        return CalendarWindow(
            start = first.atStartOfDay(zone).toInstant(),
            end = first.plusDays(count.toLong()).atStartOfDay(zone).toInstant(),
            days = days,
        )
    }

    fun startOf(entry: CalendarEntry, zone: ZoneId): ZonedDateTime? =
        entry.startsAt?.let { Instant.parse(it).atZone(zone) }

    fun endOf(entry: CalendarEntry, zone: ZoneId): ZonedDateTime? =
        entry.endsAt?.let { Instant.parse(it).atZone(zone) }

    /** The local day an entry begins on — what "open it in the calendar" shows. */
    fun dayOf(entry: CalendarEntry, zone: ZoneId): LocalDate? =
        if (entry.allDay) entry.startDate?.let(LocalDate::parse) else startOf(entry, zone)?.toLocalDate()

    private fun isOn(entry: CalendarEntry, day: LocalDate, zone: ZoneId): Boolean {
        if (entry.allDay) {
            val first = entry.startDate?.let(LocalDate::parse) ?: return false
            val last = entry.endDate?.let(LocalDate::parse) ?: first
            return !day.isBefore(first) && !day.isAfter(last)
        }
        val start = startOf(entry, zone) ?: return false
        val end = endOf(entry, zone) ?: start
        val dayStart = day.atStartOfDay(zone)
        val dayEnd = day.plusDays(1).atStartOfDay(zone)
        return if (end == start) {
            !start.isBefore(dayStart) && start.isBefore(dayEnd)
        } else {
            end.isAfter(dayStart) && start.isBefore(dayEnd)
        }
    }

    /** What `day` shows, all-day entries first, then by time. */
    fun onDay(entries: List<CalendarEntry>, day: LocalDate, zone: ZoneId): List<CalendarEntry> {
        val (allDay, timed) = entries.filter { isOn(it, day, zone) }.partition { it.allDay }
        return allDay + timed.sortedWith(compareBy({ startOf(it, zone)?.toInstant() }, { it.id }))
    }

    /** `12:00 – 13:00`, `19:00`, `All day`. */
    fun describeWhen(entry: CalendarEntry, zone: ZoneId): String {
        if (entry.allDay) return "All day"
        val start = startOf(entry, zone) ?: return ""
        val end = endOf(entry, zone) ?: return start.format(clock)
        return if (start.toLocalDate() == end.toLocalDate()) {
            "${start.format(clock)} – ${end.format(clock)}"
        } else {
            "${start.format(clock)} – ${shortDate(end.toLocalDate())}, ${end.format(clock)}"
        }
    }

    /** Monday first, as a weekly repeat stores them (#355). */
    val WEEKDAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    private val weekdayNames = mapOf(
        "mon" to "Monday", "tue" to "Tuesday", "wed" to "Wednesday", "thu" to "Thursday",
        "fri" to "Friday", "sat" to "Saturday", "sun" to "Sunday",
    )

    /** `Every day`, `Every weekday`, `Every Monday and Thursday`; null when it does not repeat. */
    fun describeRepeat(entry: CalendarEntry): String? = when (entry.repeat) {
        "daily" -> "Every day"
        "weekdays" -> "Every weekday"
        "weekly" -> {
            val names = WEEKDAYS.filter { it in entry.repeatDays }.mapNotNull(weekdayNames::get)
            when (names.size) {
                0 -> "Every week"
                1 -> "Every ${names[0]}"
                else -> "Every ${names.dropLast(1).joinToString(", ")} and ${names.last()}"
            }
        }
        else -> null
    }

    /**
     * What tells one entry from another: the id, and for a repeating
     * reminder's times — which share it — the time. List keys and the
     * selection use it.
     */
    fun entryKey(entry: CalendarEntry): String = "${entry.id}@${entry.startsAt ?: entry.startDate.orEmpty()}"

    /** `Fri 16 Oct`. */
    fun shortDate(day: LocalDate): String =
        "${day.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)} ${day.dayOfMonth} " +
            day.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)

    /** `12 – 18 October 2026`, `26 October – 1 November 2026`, `Tuesday 13 October 2026`. */
    fun title(view: CalendarView, anchor: LocalDate): String {
        fun month(d: LocalDate) = d.month.getDisplayName(TextStyle.FULL, Locale.ENGLISH)
        if (view == CalendarView.DAY) {
            return "${anchor.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH)} ${anchor.dayOfMonth} ${month(anchor)} ${anchor.year}"
        }
        val a = weekStart(anchor)
        val b = a.plusDays(6)
        return when {
            a.year != b.year -> "${a.dayOfMonth} ${month(a)} ${a.year} – ${b.dayOfMonth} ${month(b)} ${b.year}"
            a.month != b.month -> "${a.dayOfMonth} ${month(a)} – ${b.dayOfMonth} ${month(b)} ${b.year}"
            else -> "${a.dayOfMonth} – ${b.dayOfMonth} ${month(a)} ${a.year}"
        }
    }

    /**
     * What `calendar_create`, `calendar_move`, `calendar_repeat` or
     * `calendar_delete` answered, as the chat card; null for another tool, an
     * error, a listing or text.
     */
    fun toolCard(toolName: String?, content: String?, json: Json): CalendarToolCard? {
        val action = when (toolName) {
            "calendar_create" -> CalendarToolAction.CREATED
            "calendar_move" -> CalendarToolAction.MOVED
            "calendar_repeat" -> CalendarToolAction.CHANGED
            "calendar_delete" -> CalendarToolAction.DELETED
            else -> return null
        }
        if (content.isNullOrBlank()) return null
        val element = runCatching { json.parseToJsonElement(content) }.getOrNull() ?: return null
        val obj = element as? JsonObject ?: return null
        if ("error" in obj) return null
        val answer = runCatching { json.decodeFromJsonElement(ToolAnswer.serializer(), obj.jsonObject) }.getOrNull()
            ?: return null
        val summary = answer.summary ?: return null
        return when (action) {
            CalendarToolAction.DELETED -> answer.deleted?.let { CalendarToolCard(action, summary, deleted = it) }
            else -> answer.entry?.let { CalendarToolCard(action, summary, entry = it) }
        }
    }
}
