package com.kurisu.assistant.domain.notifications

import com.kurisu.assistant.data.model.NotificationEvent

/** Where tapping a notification goes (#353). The desktop's `NotificationTarget`. */
sealed interface NotificationTarget {
    data class Conversation(val conversationId: Int) : NotificationTarget
    /** A reminder in the calendar (#282); null opens the calendar itself. */
    data class Calendar(val reminderId: Int?) : NotificationTarget
    data object App : NotificationTarget
}

fun notificationTarget(event: NotificationEvent): NotificationTarget = when {
    event.source == "calendar" -> NotificationTarget.Calendar(event.reminderId)
    event.conversationId != null -> NotificationTarget.Conversation(event.conversationId)
    else -> NotificationTarget.App
}

/** Who it is from, then what it is about: `Kurisu · Flight prices to Hanoi`. */
fun notificationHeading(event: NotificationEvent): String =
    if (event.title.isNotEmpty()) "${event.sender} · ${event.title}" else event.sender
