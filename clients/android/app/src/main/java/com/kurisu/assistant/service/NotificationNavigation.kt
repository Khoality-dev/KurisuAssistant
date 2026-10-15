package com.kurisu.assistant.service

import com.kurisu.assistant.domain.notifications.NotificationTarget
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A tapped notification's target, from [com.kurisu.assistant.MainActivity] to
 * the navigation graph, which opens it and clears it (#353).
 */
@Singleton
class NotificationNavigation @Inject constructor() {
    private val _pending = MutableStateFlow<NotificationTarget?>(null)
    val pending: StateFlow<NotificationTarget?> = _pending

    fun open(target: NotificationTarget) {
        _pending.value = target
    }

    fun handled() {
        _pending.value = null
    }
}
