package com.kurisu.assistant.data.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One entry on the user's calendar (#282), as `GET /calendar/entries` answers it.
 *
 * Instants are ISO 8601 UTC strings with a `Z`; an all-day event is a pair of
 * `YYYY-MM-DD` dates with no zone. Nothing records who put an entry there.
 */
@Serializable
data class CalendarEntry(
    val id: Int,
    val kind: String,
    val title: String,
    val notes: String? = null,
    @SerialName("all_day") val allDay: Boolean = false,
    @SerialName("starts_at") val startsAt: String? = null,
    @SerialName("ends_at") val endsAt: String? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
    val done: Boolean = false,
    @SerialName("done_at") val doneAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
) {
    val isReminder: Boolean get() = kind == "reminder"
}

/** A new entry. Only what is set goes on the wire. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class CalendarEntryCreate(
    val kind: String,
    val title: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val notes: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("all_day") val allDay: Boolean? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("starts_at") val startsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("ends_at") val endsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("start_date") val startDate: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("end_date") val endDate: String? = null,
)

/**
 * A change. The route reads `model_fields_set`, so this must stay partial: an
 * explicit `null` title is refused and an explicit `null` start would
 * unschedule a reminder (see `PatchBodyTest`).
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class CalendarEntryUpdate(
    @EncodeDefault(EncodeDefault.Mode.NEVER) val title: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("starts_at") val startsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("ends_at") val endsAt: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("start_date") val startDate: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("end_date") val endDate: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val done: Boolean? = null,
)
