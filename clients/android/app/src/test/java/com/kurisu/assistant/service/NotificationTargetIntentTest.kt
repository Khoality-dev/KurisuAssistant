package com.kurisu.assistant.service

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.domain.notifications.NotificationTarget
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tapping a notification opens the app on where it came from (#353): the
 * target travels in the tap's intent and is read back by MainActivity.
 */
@RunWith(AndroidJUnit4::class)
class NotificationTargetIntentTest {

    private fun roundTrip(target: NotificationTarget): NotificationTarget? =
        NotificationTargetIntent.read(Intent().also { NotificationTargetIntent.put(it, target) })

    @Test
    fun `a conversation, a reminder, or just the app survive the trip`() {
        assertThat(roundTrip(NotificationTarget.Conversation(7))).isEqualTo(NotificationTarget.Conversation(7))
        assertThat(roundTrip(NotificationTarget.Calendar(42))).isEqualTo(NotificationTarget.Calendar(42))
        assertThat(roundTrip(NotificationTarget.Calendar(null))).isEqualTo(NotificationTarget.Calendar(null))
        assertThat(roundTrip(NotificationTarget.App)).isEqualTo(NotificationTarget.App)
    }

    @Test
    fun `it carries which notification was tapped, so it can be read`() {
        val intent = NotificationTargetIntent.put(Intent(), NotificationTarget.Conversation(7), notificationId = 12)
        assertThat(NotificationTargetIntent.notificationId(intent)).isEqualTo(12)
        assertThat(NotificationTargetIntent.notificationId(Intent())).isNull()
    }

    @Test
    fun `an intent that came from nowhere carries no target`() {
        assertThat(NotificationTargetIntent.read(Intent())).isNull()
    }
}
