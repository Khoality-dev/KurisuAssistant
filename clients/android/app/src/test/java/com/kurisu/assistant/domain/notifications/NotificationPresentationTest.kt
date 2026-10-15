package com.kurisu.assistant.domain.notifications

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.NotificationEvent
import org.junit.Test

/**
 * What tapping a notification opens, and what it says it is (#353). The rules
 * mirror the desktop's `notifications.test.ts`, so both show the same thing.
 */
class NotificationPresentationTest {

    private val base = NotificationEvent(
        id = 3,
        source = "assistant",
        sender = "Kurisu",
        title = "Flight prices to Hanoi",
        body = "A December fare dropped.",
    )

    @Test
    fun `opens the conversation it came from`() {
        assertThat(notificationTarget(base.copy(conversationId = 7))).isEqualTo(NotificationTarget.Conversation(7))
    }

    @Test
    fun `opens the reminder in the calendar`() {
        val reminder = base.copy(source = "calendar", sender = "Calendar", reminderId = 42)
        assertThat(notificationTarget(reminder)).isEqualTo(NotificationTarget.Calendar(42))
    }

    @Test
    fun `opens the app when there is nothing more specific`() {
        assertThat(notificationTarget(base)).isEqualTo(NotificationTarget.App)
    }

    @Test
    fun `names who it is from, then what it is about`() {
        assertThat(notificationHeading(base)).isEqualTo("Kurisu · Flight prices to Hanoi")
        assertThat(notificationHeading(base.copy(title = ""))).isEqualTo("Kurisu")
    }
}
