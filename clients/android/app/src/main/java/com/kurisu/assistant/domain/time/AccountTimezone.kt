package com.kurisu.assistant.domain.time

import com.kurisu.assistant.data.model.UserProfile
import java.time.ZoneId

/**
 * The account's time zone (#352): task schedules are read in it, and the server
 * has no clock to look at. The first client to find it empty fills it from its
 * own device — once, without asking — and nothing here overwrites one that is
 * set: the user may have chosen it. The desktop's `fillTimezoneIfUnset` is the twin.
 */

/** This phone's IANA zone, or null when the platform will not say. */
fun deviceTimezone(): String? = runCatching { ZoneId.systemDefault().id }.getOrNull()?.takeIf { it.contains('/') || it == "UTC" }

/** Fill [user]'s zone from [zone] through [patch] when it is empty; a refusal leaves it as it was. */
suspend fun fillTimezoneIfUnset(user: UserProfile, zone: String?, patch: suspend (String) -> Unit): UserProfile {
    if (!user.timezone.isNullOrBlank() || zone.isNullOrBlank()) return user
    return try {
        patch(zone)
        user.copy(timezone = zone)
    } catch (_: Exception) {
        user
    }
}
