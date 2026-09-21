package com.kurisu.assistant.ui.version

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import java.io.File

/**
 * The update gate offers the update rather than asking for it (#264): what
 * the one button reads in every state, the sentence under it, and when the
 * offer is withheld because the server is the side behind.
 */
class UpdateFlowTest {

    @Test
    fun `the button reads Update now whenever a check can be started`() {
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.Idle)).isEqualTo("Update now")
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.None)).isEqualTo("Update now")
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.Error("x"))).isEqualTo("Update now")
    }

    @Test
    fun `nothing can be pressed while checking or downloading`() {
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.Checking)).isNull()
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.Downloading("v1.0.0", 0.5f))).isNull()
    }

    @Test
    fun `a downloaded release is installed, not checked again`() {
        assertThat(UpdateFlow.buttonLabel(UpdateFlowState.Ready("v1.0.0", File("update.apk"))))
            .isEqualTo("Install update")
    }

    @Test
    fun `every resting state has its sentence and idle has none`() {
        assertThat(UpdateFlow.describe(UpdateFlowState.Idle, "0.7.0")).isNull()
        assertThat(UpdateFlow.describe(UpdateFlowState.Checking, "0.7.0")).isEqualTo("Checking for a newer release…")
        assertThat(UpdateFlow.describe(UpdateFlowState.Downloading("v1.0.0", 0.426f), "0.7.0"))
            .isEqualTo("Downloading v1.0.0… 42%")
        assertThat(UpdateFlow.describe(UpdateFlowState.Ready("v1.0.0", File("update.apk")), "0.7.0"))
            .isEqualTo("Version v1.0.0 is downloaded. Install it to finish.")
        assertThat(UpdateFlow.describe(UpdateFlowState.None, "0.7.0"))
            .isEqualTo("You already have the newest release (0.7.0). The server is what has to be updated.")
        assertThat(UpdateFlow.describe(UpdateFlowState.Error("Could not check for updates: timeout"), "0.7.0"))
            .isEqualTo("Could not check for updates: timeout")
    }

    @Test
    fun `progress is clamped into the percent range`() {
        assertThat(UpdateFlow.describe(UpdateFlowState.Downloading("v1", 1.7f), "0.7.0")).isEqualTo("Downloading v1… 100%")
        assertThat(UpdateFlow.describe(UpdateFlowState.Downloading("v1", -0.2f), "0.7.0")).isEqualTo("Downloading v1… 0%")
    }

    @Test
    fun `the offer is made only when this app is the side behind, or nobody knows`() {
        assertThat(UpdateFlow.offersUpdate(clientWire = 6, serverWire = 7)).isTrue()
        assertThat(UpdateFlow.offersUpdate(clientWire = 7, serverWire = 6)).isFalse()
        assertThat(UpdateFlow.offersUpdate(clientWire = 7, serverWire = -1)).isTrue()
    }

    @Test
    fun `a failure names the stage and the reason, even without a message`() {
        assertThat(UpdateFlow.failed("check for updates", RuntimeException("no route")).message)
            .isEqualTo("Could not check for updates: no route")
        assertThat(UpdateFlow.failed("download the update", IllegalStateException()).message)
            .isEqualTo("Could not download the update: IllegalStateException")
    }
}
