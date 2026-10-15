package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.CalendarEntry
import com.kurisu.assistant.data.model.CalendarEntryCreate
import com.kurisu.assistant.data.model.CalendarEntryUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The user's calendar (#282) over the `/calendar` endpoints. The desktop calls
 * the same ones (`@kurisu/api` `client.ts`).
 */
@Singleton
class CalendarRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /** Every entry overlapping `[start, end)`, both ISO 8601 UTC. */
    suspend fun list(start: String, end: String): List<CalendarEntry> = api.listCalendarEntries(start, end)

    suspend fun upcoming(limit: Int = 20): List<CalendarEntry> = api.getUpcomingCalendar(limit)

    suspend fun get(id: Int): CalendarEntry = api.getCalendarEntry(id)

    suspend fun create(body: CalendarEntryCreate): CalendarEntry = api.createCalendarEntry(body)

    suspend fun update(id: Int, changes: CalendarEntryUpdate): CalendarEntry = api.updateCalendarEntry(id, changes)

    suspend fun delete(id: Int) = api.deleteCalendarEntry(id)

}
