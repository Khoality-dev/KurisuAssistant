package com.kurisu.assistant.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.kurisu.assistant.MainActivity
import com.kurisu.assistant.R
import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.domain.notifications.NotificationChanges
import com.kurisu.assistant.domain.notifications.notificationHeading
import com.kurisu.assistant.domain.notifications.notificationTarget
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Posts and cancels this phone's system notifications (#353), whichever way
 * they arrived — a Firebase push with the app closed, or the socket while it
 * is open — so they look the same: `<sender> · <title>`, the body, and a tap
 * that opens where it came from and reads it. Each is keyed by the server's id,
 * so one read on any device is cancelled here.
 */
@Singleton
class NotificationPoster @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "NotificationPoster"
        const val ALERTS_CHANNEL_ID = "kurisu_notifications"
        /** Posted notifications are numbered from here by their server id. */
        private const val POSTED_ID_BASE = 10_000
    }

    fun apply(changes: NotificationChanges) {
        changes.cancel.forEach(::cancel)
        changes.post.forEach(::post)
    }

    fun post(event: NotificationEvent) {
        createChannel()
        val tap = NotificationTargetIntent.put(
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            notificationTarget(event),
            notificationId = event.id,
        )
        val pending = PendingIntent.getActivity(
            context, event.id, tap,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val built = NotificationCompat.Builder(context, ALERTS_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(notificationHeading(event))
            .setContentText(event.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body))
            .setCategory(if (event.source == "calendar") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .apply { createdAtMillis(event)?.let { setWhen(it).setShowWhen(true) } }
            .build()
        try {
            NotificationManagerCompat.from(context).notify(POSTED_ID_BASE + event.id, built)
        } catch (e: SecurityException) {
            // Notifications are not allowed for this app (Android 13+ asks first).
            Log.w(TAG, "Not allowed to post a notification: ${e.message}")
        }
    }

    /** Read on some device — this one or another: take it down. */
    fun cancel(id: Int) {
        NotificationManagerCompat.from(context).cancel(POSTED_ID_BASE + id)
    }

    private fun createdAtMillis(event: NotificationEvent): Long? =
        try { Instant.parse(event.createdAt).toEpochMilli() } catch (_: Exception) { null }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(ALERTS_CHANNEL_ID, "Assistant and reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Messages from the assistant and calendar reminders"
            },
        )
    }
}
