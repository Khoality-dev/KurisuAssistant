package com.kurisu.assistant.ui.navigation

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.domain.notifications.NotificationTarget
import org.junit.Test

/** Where a tapped notification lands (#353), the calendar's included (#282). */
class NotificationRouteTest {
    @Test
    fun a_conversation_opens_in_the_chat() {
        assertThat(Routes.forNotification(NotificationTarget.Conversation(7))).isEqualTo(Routes.CHAT)
    }

    @Test
    fun a_reminder_opens_the_calendar_on_it() {
        assertThat(Routes.forNotification(NotificationTarget.Calendar(42))).isEqualTo("calendar?reminderId=42")
    }

    @Test
    fun a_calendar_notification_naming_no_reminder_opens_the_calendar() {
        assertThat(Routes.forNotification(NotificationTarget.Calendar(null))).isEqualTo(Routes.CALENDAR)
    }

    @Test
    fun anything_else_stays_where_the_app_is() {
        assertThat(Routes.forNotification(NotificationTarget.App)).isNull()
    }
}
