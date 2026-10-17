package com.kurisu.assistant.data.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * One entry on the user's calendar (#282), as `GET /calendar/entries` answers it.
 *
 * Instants are ISO 8601 UTC strings with a `Z`; an all-day event is a pair of
 * `YYYY-MM-DD` dates with no zone. Nothing records who put an entry there.
 *
 * A reminder can repeat (#355): the server answers it as its times, one entry
 * per time with the same [id], [startsAt] that time and [done] that time's own;
 * [repeatFrom] is its first time, which an edit changes.
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
    /** `daily`, `weekdays` or `weekly`; null when it does not repeat. */
    val repeat: String? = null,
    /** A weekly repeat's days, `mon` … `sun`. */
    @SerialName("repeat_days") val repeatDays: List<String> = emptyList(),
    @SerialName("repeat_from") val repeatFrom: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
) {
    val isReminder: Boolean get() = kind == "reminder"
    val isRepeating: Boolean get() = repeat != null
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
    @EncodeDefault(EncodeDefault.Mode.NEVER) val repeat: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("repeat_days") val repeatDays: List<String>? = null,
)

/**
 * A change. The route reads `model_fields_set`, so this must stay partial: an
 * explicit `null` title is refused and an explicit `null` start would
 * unschedule a reminder (see `PatchBodyTest`).
 *
 * [repeat] is the one field a change may set to an explicit `null` — that stops
 * a repeat (#355) — so it is a [JsonElement]: [JsonNull] goes on the wire, Kotlin
 * `null` stays off it. Build it with [repeat]. Done on one time of a repeating
 * reminder names the time in [occurrenceAt].
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
    @EncodeDefault(EncodeDefault.Mode.NEVER) val repeat: JsonElement? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("repeat_days") val repeatDays: List<String>? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER) @SerialName("occurrence_at") val occurrenceAt: String? = null,
) {
    companion object {
        /** A repeat to send: the rule, or `null` to stop it repeating. */
        fun repeat(rule: String?): JsonElement = rule?.let(::JsonPrimitive) ?: JsonNull
    }
}
