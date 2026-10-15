package com.kurisu.assistant.service

import android.content.Intent
import com.kurisu.assistant.domain.notifications.NotificationTarget

/**
 * Where a tapped notification goes, carried in the tap's intent and read back
 * by [com.kurisu.assistant.MainActivity] (#353).
 */
object NotificationTargetIntent {
    private const val EXTRA_KIND = "com.kurisu.assistant.notification.KIND"
    private const val EXTRA_ID = "com.kurisu.assistant.notification.ID"
    private const val EXTRA_NOTIFICATION_ID = "com.kurisu.assistant.notification.NOTIFICATION_ID"

    /** [notificationId] is the server's, so a tap can read it everywhere. */
    fun put(intent: Intent, target: NotificationTarget, notificationId: Int? = null): Intent = intent.apply {
        notificationId?.let { putExtra(EXTRA_NOTIFICATION_ID, it) }
        when (target) {
            is NotificationTarget.Conversation -> {
                putExtra(EXTRA_KIND, "conversation")
                putExtra(EXTRA_ID, target.conversationId)
            }
            is NotificationTarget.Calendar -> {
                putExtra(EXTRA_KIND, "calendar")
                target.reminderId?.let { putExtra(EXTRA_ID, it) }
            }
            NotificationTarget.App -> putExtra(EXTRA_KIND, "app")
        }
    }

    fun notificationId(intent: Intent?): Int? =
        if (intent?.hasExtra(EXTRA_NOTIFICATION_ID) == true) intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0) else null

    fun read(intent: Intent?): NotificationTarget? {
        val id = if (intent?.hasExtra(EXTRA_ID) == true) intent.getIntExtra(EXTRA_ID, 0) else null
        return when (intent?.getStringExtra(EXTRA_KIND)) {
            "conversation" -> id?.let { NotificationTarget.Conversation(it) }
            "calendar" -> NotificationTarget.Calendar(id)
            "app" -> NotificationTarget.App
            else -> null
        }
    }
}
