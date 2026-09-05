package com.kurisu.assistant.ui.chat

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * The voice bar counts down from a DEADLINE, not from a tick counter, so a
 * screen that was off for ten seconds comes back showing ten fewer seconds
 * rather than the number it stopped on.
 */
class VoiceCountdownTest {

    private val now = 1_000_000L

    @Test
    fun `no armed timer means no countdown line`() {
        assertThat(secondsUntil(null, now)).isNull()
    }

    @Test
    fun `a fresh 30s deadline reads as 30s`() {
        assertThat(secondsUntil(now + 30_000L, now)).isEqualTo(30)
    }

    @Test
    fun `partial seconds round up so the line never shows a second early`() {
        assertThat(secondsUntil(now + 26_600L, now)).isEqualTo(27)
        assertThat(secondsUntil(now + 1L, now)).isEqualTo(1)
    }

    @Test
    fun `an elapsed deadline floors at zero rather than going negative`() {
        assertThat(secondsUntil(now - 5_000L, now)).isEqualTo(0)
        assertThat(secondsUntil(now, now)).isEqualTo(0)
    }
}
