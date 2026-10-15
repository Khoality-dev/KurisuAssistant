package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A notification as the server keeps it and `/ws/notifications` carries it
 * (#353). The server keeps every notification and whether it has been read; the
 * phone only displays them. Mirrors the backend's `notifications/service.py::
 * to_event` and the desktop's `NotificationEvent`. Not on the chat socket: the
 * background service holds its own.
 */
@Serializable
data class NotificationEvent(
    override val type: String = "notification",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val id: Int = 0,
    val source: String = "assistant",
    /** What to show it as: the persona in use when it was sent, `Assistant`, or `Calendar`. */
    val sender: String = "",
    val title: String = "",
    val body: String = "",
    @SerialName("conversation_id") val conversationId: Int? = null,
    @SerialName("reminder_id") val reminderId: Int? = null,
    @SerialName("created_at") val createdAt: String = "",
    /** Null until a device reads it; then every device takes it down. */
    @SerialName("read_at") val readAt: String? = null,
) : ServerEvent

/** On connect: what is unread (the last week, at most 50, oldest first). */
@Serializable
data class NotificationsReadyEvent(
    override val type: String = "notifications_ready",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val unread: List<NotificationEvent> = emptyList(),
) : ServerEvent

/** Some were just read, on whichever device: take each down. */
@Serializable
data class NotificationsReadEvent(
    override val type: String = "notifications_read",
    @SerialName("event_id") override val eventId: String = "",
    override val timestamp: String = "",
    val ids: List<Int> = emptyList(),
    @SerialName("read_at") val readAt: String? = null,
) : ServerEvent

/** `GET /notifications`: unread first, then newest first. */
@Serializable
data class NotificationList(
    val notifications: List<NotificationEvent> = emptyList(),
    @SerialName("unread_count") val unreadCount: Int = 0,
)

/** `POST /notifications/read-for`: what the user just opened — one of the two. */
@Serializable
data class NotificationReadFor(
    @SerialName("conversation_id") val conversationId: Int? = null,
    @SerialName("reminder_id") val reminderId: Int? = null,
)

/** `POST /notifications/devices`: this phone's FCM token, for push (#353). */
@Serializable
data class DeviceRegistration(
    val platform: String,
    @SerialName("fcm_token") val fcmToken: String,
)

@Serializable
data class DeviceRegistrationResult(
    val registered: Boolean = false,
    /** Whether the server pushes at all — false without a Firebase service account. */
    val push: Boolean = false,
)

/** What a read-all or read-for call read. */
@Serializable
data class NotificationReadResult(
    val ids: List<Int> = emptyList(),
    @SerialName("read_at") val readAt: String? = null,
)
