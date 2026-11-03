package com.amadeus.assistant.data.repository

import com.amadeus.assistant.data.model.CalendarEntry
import com.amadeus.assistant.data.model.CalendarEntryCreate
import com.amadeus.assistant.data.model.CalendarEntryUpdate
import com.amadeus.assistant.data.remote.api.AmadeusApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The user's calendar (#282) over the `/calendar` endpoints. The desktop calls
 * the same ones (`@amadeus/api` `client.ts`).
 */
@Singleton
class CalendarRepository @Inject constructor(
    private val api: AmadeusApiService,
) {
    /** Every entry overlapping `[start, end)`, both ISO 8601 UTC. */
    suspend fun list(start: String, end: String): List<CalendarEntry> = api.listCalendarEntries(start, end)

    suspend fun upcoming(limit: Int = 20): List<CalendarEntry> = api.getUpcomingCalendar(limit)

    suspend fun get(id: Int): CalendarEntry = api.getCalendarEntry(id)

    suspend fun create(body: CalendarEntryCreate): CalendarEntry = api.createCalendarEntry(body)

    suspend fun update(id: Int, changes: CalendarEntryUpdate): CalendarEntry = api.updateCalendarEntry(id, changes)

    suspend fun delete(id: Int) = api.deleteCalendarEntry(id)

}
