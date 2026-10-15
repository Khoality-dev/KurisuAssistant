package com.kurisu.assistant.service

import com.kurisu.assistant.domain.notifications.NotificationTarget
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A tapped notification's target, from [com.kurisu.assistant.MainActivity] to
 * the navigation graph, which opens it and clears it (#353). A calendar target
 * waits in [calendarRequest] for the calendar screen to pick it up (#282).
 */
@Singleton
class NotificationNavigation @Inject constructor() {
    private val _pending = MutableStateFlow<NotificationTarget?>(null)
    val pending: StateFlow<NotificationTarget?> = _pending

    private val _calendarRequest = MutableStateFlow<NotificationTarget.Calendar?>(null)
    /** The reminder a notification asked to see, for the calendar (#282) to open. */
    val calendarRequest: StateFlow<NotificationTarget.Calendar?> = _calendarRequest

    fun open(target: NotificationTarget) {
        _pending.value = target
        if (target is NotificationTarget.Calendar) _calendarRequest.value = target
    }

    fun handled() {
        _pending.value = null
    }

    fun clearCalendarRequest() {
        _calendarRequest.value = null
    }
}
