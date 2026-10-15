package com.kurisu.assistant.domain.notifications

import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.data.model.NotificationsReadEvent
import com.kurisu.assistant.data.model.NotificationsReadyEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** `/ws/notifications` on [baseUrl] (#353). */
fun notificationsUrl(baseUrl: String): String {
    val ws = baseUrl.trimEnd('/')
        .replace(Regex("^http:"), "ws:")
        .replace(Regex("^https:"), "wss:")
    return "$ws/ws/notifications"
}

/** What one socket message asks of the phone: notifications to post, and ids to cancel. */
data class NotificationChanges(
    val post: List<NotificationEvent> = emptyList(),
    val cancel: List<Int> = emptyList(),
) {
    fun isEmpty(): Boolean = post.isEmpty() && cancel.isEmpty()
}

/**
 * The phone's side of its notifications socket (#353). The server keeps every
 * notification and whether it has been read; the phone only displays them. The
 * one thing it keeps is [shown] — which it has already posted — so a reconnect
 * posts each unread one once and cancels the ones read elsewhere meanwhile.
 * [unread] mirrors what the server says is unread, newest first. The desktop's
 * `startNotifications` does the same.
 */
class NotificationSync(shown: Set<Int>) {

    var shown: Set<Int> = shown
        private set

    var unread: List<NotificationEvent> = emptyList()
        private set

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun handle(text: String): NotificationChanges {
        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            return NotificationChanges()
        }
        return try {
            when (obj["type"]?.jsonPrimitive?.content) {
                "notifications_ready" -> sync(json.decodeFromJsonElement(NotificationsReadyEvent.serializer(), obj).unread)
                "notification" -> arrived(json.decodeFromJsonElement(NotificationEvent.serializer(), obj))
                "notifications_read" -> read(json.decodeFromJsonElement(NotificationsReadEvent.serializer(), obj).ids)
                else -> NotificationChanges()
            }
        } catch (_: Exception) {
            NotificationChanges()
        }
    }

    /**
     * A Firebase data message (#353): every value a string, null as "" — the
     * same `notification` and `notifications_read` as on the socket, so a push
     * and the socket agree on what was posted.
     */
    fun handlePush(data: Map<String, String>): NotificationChanges = when (data["type"]) {
        "notification" -> {
            val id = data["id"]?.toIntOrNull()
            if (id == null) NotificationChanges() else arrived(
                NotificationEvent(
                    id = id,
                    source = data["source"].orEmpty().ifEmpty { "assistant" },
                    sender = data["sender"].orEmpty(),
                    title = data["title"].orEmpty(),
                    body = data["body"].orEmpty(),
                    conversationId = data["conversation_id"]?.toIntOrNull(),
                    reminderId = data["reminder_id"]?.toIntOrNull(),
                    createdAt = data["created_at"].orEmpty(),
                    readAt = data["read_at"]?.ifEmpty { null },
                ),
            )
        }
        "notifications_read" -> read(data["ids"].orEmpty().split(',').mapNotNull { it.trim().toIntOrNull() })
        else -> NotificationChanges()
    }

    /** What the server says is unread, from a list fetched over REST — posts nothing. */
    fun replaceUnread(list: List<NotificationEvent>) {
        unread = list.sortedByDescending { it.id }
    }

    private fun sync(list: List<NotificationEvent>): NotificationChanges {
        val stillUnread = list.map { it.id }.toSet()
        val cancel = shown.filter { it !in stillUnread }
        val post = list.filter { it.id !in shown }
        shown = shown.intersect(stillUnread) + post.map { it.id }
        unread = list.sortedByDescending { it.id }
        return NotificationChanges(post = post, cancel = cancel)
    }

    private fun arrived(event: NotificationEvent): NotificationChanges {
        unread = (listOf(event) + unread.filter { it.id != event.id }).sortedByDescending { it.id }
        if (event.id in shown) return NotificationChanges()
        shown = shown + event.id
        return NotificationChanges(post = listOf(event))
    }

    private fun read(ids: List<Int>): NotificationChanges {
        val gone = ids.toSet()
        unread = unread.filter { it.id !in gone }
        shown = shown - gone
        return NotificationChanges(cancel = ids)
    }
}
