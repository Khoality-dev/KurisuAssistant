package com.kurisu.assistant.service

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class VoiceInteractionManagerTest {

    private lateinit var manager: VoiceInteractionManager
    private val sent = mutableListOf<String>()
    private var enterCount = 0
    private var exitCount = 0

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        manager = VoiceInteractionManager(context)
        manager.onTranscriptSend = { sent.add(it) }
        manager.onEnterMode = { enterCount++ }
        manager.onExitMode = { exitCount++ }
        sent.clear()
        enterCount = 0
        exitCount = 0
    }

    @After
    fun tearDown() {
        manager.release()
    }

    @Test
    fun `transcript without trigger word returns false and does not send`() {
        manager.setTriggerWord("kurisu")
        val consumed = manager.handleTranscript("hello there")
        assertThat(consumed).isFalse()
        assertThat(sent).isEmpty()
        assertThat(enterCount).isEqualTo(0)
    }

    @Test
    fun `transcript with trigger word enters mode and sends`() {
        manager.setTriggerWord("kurisu")
        val consumed = manager.handleTranscript("hey Kurisu, what time is it")
        assertThat(consumed).isTrue()
        assertThat(enterCount).isEqualTo(1)
        assertThat(sent).containsExactly("hey Kurisu, what time is it")
        assertThat(manager.state.value.isInteractionMode).isTrue()
    }

    @Test
    fun `in interaction mode all transcripts are auto-sent`() {
        manager.setTriggerWord("kurisu")
        manager.enterMode()
        sent.clear()

        manager.handleTranscript("follow up question")
        assertThat(sent).containsExactly("follow up question")
    }

    @Test
    fun `in interaction mode transcripts are buffered while streaming`() {
        manager.setTriggerWord("kurisu")
        manager.enterMode()
        sent.clear()
        manager.isStreaming = true

        manager.handleTranscript("while streaming")
        assertThat(sent).isEmpty() // buffered

        manager.isStreaming = false
        manager.onStreamingComplete()
        assertThat(sent).containsExactly("while streaming")
    }

    @Test
    fun `onStreamingComplete is noop when no pending`() {
        manager.enterMode()
        sent.clear()
        manager.onStreamingComplete()
        assertThat(sent).isEmpty()
    }

    @Test
    fun `null trigger word keeps transcripts as dictation`() {
        manager.setTriggerWord(null)
        assertThat(manager.handleTranscript("kurisu")).isFalse()
    }

    @Test
    fun `trigger word match is case insensitive`() {
        manager.setTriggerWord("Kurisu")
        assertThat(manager.handleTranscript("hey kurisu")).isTrue()
        assertThat(enterCount).isEqualTo(1)
    }

    @Test
    fun `exitMode resets state and invokes callback`() = runTest {
        manager.enterMode()
        assertThat(manager.state.value.isInteractionMode).isTrue()

        manager.exitMode()
        assertThat(manager.state.value.isInteractionMode).isFalse()
        assertThat(exitCount).isEqualTo(1)
    }

    @Test
    fun `enterMode is idempotent`() {
        manager.enterMode()
        manager.enterMode()
        assertThat(enterCount).isEqualTo(1)
    }

    @Test
    fun `state flow emits mode transitions`() = runTest {
        manager.state.test {
            assertThat(awaitItem().isInteractionMode).isFalse()
            manager.enterMode()
            assertThat(awaitItem().isInteractionMode).isTrue()
            manager.exitMode()
            assertThat(awaitItem().isInteractionMode).isFalse()
        }
    }

    @Test
    fun `onTTSAndStreamingIdle starts timer only when idle and in mode`() {
        // When not in mode, should be a noop (no crash)
        manager.isStreaming = false
        manager.isTTSActive = false
        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.isInteractionMode).isFalse()
    }

    // ── Idle countdown ────────────────────────────────────────────────────
    // The composer shows "idle timeout in {n}s". It needs the instant the timer
    // fires, not the constant: seconds counted in the UI drift the moment the
    // screen sleeps or a recomposition is skipped.

    @Test
    fun `no idle deadline is armed until streaming and speech both stop`() {
        manager.enterMode()
        assertThat(manager.state.value.idleDeadlineMs).isNull()

        manager.isStreaming = true
        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.idleDeadlineMs).isNull()
    }

    @Test
    fun `going idle arms a deadline one timeout away`() {
        manager.enterMode()
        val before = System.currentTimeMillis()
        manager.onTTSAndStreamingIdle()
        val after = System.currentTimeMillis()

        val deadline = manager.state.value.idleDeadlineMs
        assertThat(deadline).isNotNull()
        assertThat(deadline!!).isAtLeast(before + VoiceInteractionManager.IDLE_TIMEOUT_MS)
        assertThat(deadline).isAtMost(after + VoiceInteractionManager.IDLE_TIMEOUT_MS)
    }

    @Test
    fun `a new transcript restarts the wait, so the deadline moves forward`() {
        manager.enterMode()
        manager.onTTSAndStreamingIdle()
        val first = manager.state.value.idleDeadlineMs!!

        // Answering resets the clock: the countdown must not keep running down
        // while the user is still talking.
        manager.handleTranscript("still here")
        assertThat(manager.state.value.idleDeadlineMs).isNull()

        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.idleDeadlineMs!!).isAtLeast(first)
    }

    @Test
    fun `leaving voice mode clears the deadline`() {
        manager.enterMode()
        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.idleDeadlineMs).isNotNull()

        manager.exitMode()
        assertThat(manager.state.value.idleDeadlineMs).isNull()
        assertThat(manager.state.value.isInteractionMode).isFalse()
    }

    @Test
    fun `the wake word API is unchanged — it is assistant-level, not per persona`() {
        // setTriggerWord(String?) keeps its shape: one word wakes the assistant
        // and the conversation's bound persona answers. It selects no one.
        manager.setTriggerWord("kurisu")
        assertThat(manager.handleTranscript("kurisu are you there")).isTrue()
        manager.exitMode()
        manager.setTriggerWord(null)
        assertThat(manager.handleTranscript("kurisu are you there")).isFalse()
    }
}
