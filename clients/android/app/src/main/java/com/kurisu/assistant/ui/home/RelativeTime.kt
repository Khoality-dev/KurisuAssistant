package com.kurisu.assistant.ui.home

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

fun formatRelativeTime(isoTimestamp: String): String {
    val instant = try {
        Instant.parse(isoTimestamp)
    } catch (_: Exception) {
        return ""
    }

    val now = Instant.now()
    val duration = Duration.between(instant, now)
    val seconds = duration.seconds

    if (seconds < 60) return "Just now"
    if (seconds < 3600) return "${seconds / 60}m ago"
    if (seconds < 86400) return "${seconds / 3600}h ago"

    val messageDate = instant.atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()

    if (messageDate == today.minusDays(1)) return "Yesterday"

    // Within the last 7 days: show day name
    if (messageDate.isAfter(today.minusDays(7))) {
        return messageDate.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
    }

    // Older: show "Jan 5" format
    return messageDate.format(DateTimeFormatter.ofPattern("MMM d"))
}
