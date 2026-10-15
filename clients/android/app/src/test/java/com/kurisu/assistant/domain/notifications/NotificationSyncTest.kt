package com.kurisu.assistant.domain.notifications

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * What the phone does with its notifications socket (#353). The server keeps
 * every notification and whether it has been read; the phone only displays
 * them, remembering which it has already posted so a reconnect posts each
 * unread one once and cancels the ones read on another device meanwhile.
 */
class NotificationSyncTest {

    private fun notification(id: Int, conversationId: Int? = null) =
        """{"type":"notification","id":$id,"source":"assistant","sender":"Kurisu","title":"n$id","body":"","conversation_id":${conversationId ?: "null"},"reminder_id":null,"created_at":"2026-10-16T08:02:00Z","read_at":null}"""

    private fun ready(vararg ids: Int) =
        """{"type":"notifications_ready","unread":[${ids.joinToString(",") { notification(it) }}]}"""

    @Test
    fun `listens on the notifications socket`() {
        assertThat(notificationsUrl("https://kurisu.example:8443")).isEqualTo("wss://kurisu.example:8443/ws/notifications")
        assertThat(notificationsUrl("http://10.0.2.2:15597/")).isEqualTo("ws://10.0.2.2:15597/ws/notifications")
    }

    @Test
    fun `posts each unread one once`() {
        val sync = NotificationSync(shown = emptySet())
        val first = sync.handle(ready(1, 2))
        assertThat(first.post.map { it.id }).containsExactly(1, 2).inOrder()
        assertThat(first.cancel).isEmpty()
        assertThat(sync.unread.map { it.id }).containsExactly(2, 1).inOrder()

        val again = sync.handle(ready(1, 2))
        assertThat(again.post).isEmpty()
        assertThat(sync.shown).containsExactly(1, 2)
    }

    @Test
    fun `back from being away, cancels what was read meanwhile and posts what is new`() {
        val sync = NotificationSync(shown = setOf(1, 2))
        val changes = sync.handle(ready(2, 3))
        assertThat(changes.cancel).containsExactly(1)
        assertThat(changes.post.map { it.id }).containsExactly(3)
        assertThat(sync.shown).containsExactly(2, 3)
    }

    @Test
    fun `a new one is posted and listed`() {
        val sync = NotificationSync(shown = emptySet())
        sync.handle(ready())
        val changes = sync.handle(notification(9, conversationId = 7))
        assertThat(changes.post.map { it.id }).containsExactly(9)
        assertThat(sync.unread.single().conversationId).isEqualTo(7)
        assertThat(sync.handle(notification(9)).post).isEmpty()
    }

    @Test
    fun `read on any device, it is cancelled here and leaves the list`() {
        val sync = NotificationSync(shown = emptySet())
        sync.handle(ready(1, 2))
        val changes = sync.handle("""{"type":"notifications_read","ids":[1],"read_at":"2026-10-16T09:00:00Z"}""")
        assertThat(changes.cancel).containsExactly(1)
        assertThat(sync.unread.map { it.id }).containsExactly(2)
        assertThat(sync.shown).containsExactly(2)
    }

    @Test
    fun `ignores what it does not understand`() {
        val sync = NotificationSync(shown = setOf(4))
        assertThat(sync.handle("not json").isEmpty()).isTrue()
        assertThat(sync.handle("""{"type":"something_else"}""").isEmpty()).isTrue()
        assertThat(sync.shown).containsExactly(4)
    }

    private fun pushed(id: Int) = mapOf(
        "type" to "notification", "id" to "$id", "source" to "calendar", "sender" to "Calendar",
        "title" to "Call Mom", "body" to "Due at 19:00.", "conversation_id" to "", "reminder_id" to "42",
        "created_at" to "2026-10-16T19:00:00Z", "read_at" to "",
    )

    @Test
    fun `a pushed notification is posted, the same as one from the socket`() {
        val sync = NotificationSync(shown = emptySet())
        val changes = sync.handlePush(pushed(7))
        val event = changes.post.single()
        assertThat(event.id).isEqualTo(7)
        assertThat(event.reminderId).isEqualTo(42)
        assertThat(event.conversationId).isNull()
        assertThat(event.title).isEqualTo("Call Mom")
        assertThat(sync.shown).containsExactly(7)
    }

    @Test
    fun `pushed and then on the socket, it is posted once`() {
        val sync = NotificationSync(shown = emptySet())
        sync.handlePush(pushed(7))
        assertThat(sync.handle(ready(7)).post).isEmpty()
    }

    @Test
    fun `a pushed read cancels those ids`() {
        val sync = NotificationSync(shown = setOf(3, 4, 5))
        val changes = sync.handlePush(mapOf("type" to "notifications_read", "ids" to "3,5"))
        assertThat(changes.cancel).containsExactly(3, 5)
        assertThat(sync.shown).containsExactly(4)
    }

    @Test
    fun `a push it does not understand changes nothing`() {
        val sync = NotificationSync(shown = setOf(1))
        assertThat(sync.handlePush(mapOf("type" to "notification", "id" to "x")).isEmpty()).isTrue()
        assertThat(sync.handlePush(mapOf("foo" to "bar")).isEmpty()).isTrue()
    }
}
