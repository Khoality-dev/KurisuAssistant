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

/**
 * Voice mode, the wake word and an interaction (#341), the same model as the
 * desktop (#253):
 *
 * - voice mode is on or off, chosen by the user, and the only time the mic
 *   listens — off, nothing said is used, and nothing becomes dictation;
 * - in voice mode, the wake word starts an interaction and anything else is
 *   ignored;
 * - an interaction sends everything said, and each one is a new conversation;
 * - it ends 30 s after the assistant's last reply, finished answering and
 *   speaking, with nothing said since; talking holds that window open.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class VoiceInteractionManagerTest {

    private lateinit var manager: VoiceInteractionManager
    private val sent = mutableListOf<Pair<String, Boolean>>()
    private var now = 1_000_000L

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        manager = VoiceInteractionManager(context)
        manager.clock = { now }
        manager.onTranscriptSend = { text, newConversation -> sent.add(text to newConversation) }
        manager.setTriggerWord("kurisu")
        sent.clear()
    }

    @After
    fun tearDown() {
        manager.release()
    }

    // ── Voice mode ────────────────────────────────────────────────────────

    @Test
    fun `voice mode starts off, and off nothing said is used`() {
        assertThat(manager.state.value.voiceMode).isFalse()

        manager.handleTranscript("hey Kurisu, what time is it")

        assertThat(sent).isEmpty()
        assertThat(manager.state.value.interactionActive).isFalse()
    }

    @Test
    fun `turned on, it waits for the wake word with no interaction yet`() {
        manager.setVoiceMode(true)

        assertThat(manager.state.value.voiceMode).isTrue()
        assertThat(manager.state.value.interactionActive).isFalse()
    }

    @Test
    fun `turned off, it ends the interaction`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, hello")

        manager.setVoiceMode(false)

        assertThat(manager.state.value.voiceMode).isFalse()
        assertThat(manager.state.value.interactionActive).isFalse()
        assertThat(manager.state.value.idleDeadlineMs).isNull()
    }

    // ── The wake word ─────────────────────────────────────────────────────

    @Test
    fun `the wake word starts an interaction in a new conversation, and is its first message`() {
        manager.setVoiceMode(true)

        manager.handleTranscript("hey Kurisu, what time is it")

        assertThat(manager.state.value.interactionActive).isTrue()
        assertThat(sent).containsExactly("hey Kurisu, what time is it" to true)
        assertThat(manager.state.value.wokeAtMs).isEqualTo(now)
    }

    @Test
    fun `speech without the wake word is ignored, not turned into dictation`() {
        manager.setVoiceMode(true)

        manager.handleTranscript("buy milk on the way home")

        assertThat(sent).isEmpty()
        assertThat(manager.state.value.interactionActive).isFalse()
    }

    @Test
    fun `with no wake word set, nothing starts an interaction`() {
        manager.setTriggerWord(null)
        manager.setVoiceMode(true)

        manager.handleTranscript("kurisu")

        assertThat(sent).isEmpty()
    }

    @Test
    fun `the wake word is heard in any case, anywhere in what was said`() {
        manager.setTriggerWord("Kurisu")
        manager.setVoiceMode(true)

        manager.handleTranscript("ok so kurisu listen")

        assertThat(manager.state.value.interactionActive).isTrue()
    }

    // ── An interaction ────────────────────────────────────────────────────

    @Test
    fun `in an interaction everything said is sent to that conversation, with no wake word`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, are you there?")
        sent.clear()

        manager.handleTranscript("and tomorrow?")

        assertThat(sent).containsExactly("and tomorrow?" to false)
    }

    @Test
    fun `what is said while the reply streams is sent when it finishes`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, hello")
        sent.clear()
        manager.isStreaming = true

        manager.handleTranscript("while streaming")
        assertThat(sent).isEmpty()

        manager.isStreaming = false
        manager.onStreamingComplete()
        assertThat(sent).containsExactly("while streaming" to false)
    }

    @Test
    fun `the next interaction is another new conversation`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, first question")
        manager.endInteraction()

        manager.handleTranscript("Kurisu, second question")

        assertThat(sent.last()).isEqualTo("Kurisu, second question" to true)
    }

    @Test
    fun `what was last said stays for the whole interaction, and goes when it ends`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, how long do I boil an egg?")
        manager.onTTSAndStreamingIdle()

        assertThat(manager.state.value.lastTranscript).isEqualTo("Kurisu, how long do I boil an egg?")

        manager.endInteraction()
        assertThat(manager.state.value.lastTranscript).isNull()
        assertThat(manager.state.value.wokeAtMs).isNull()
        assertThat(manager.state.value.voiceMode).isTrue()
    }

    // ── The 30-second window ──────────────────────────────────────────────

    @Test
    fun `no window opens while the reply streams or is spoken`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, hello")

        manager.isStreaming = true
        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.idleDeadlineMs).isNull()

        manager.isStreaming = false
        manager.isTTSActive = true
        manager.onTTSAndStreamingIdle()
        assertThat(manager.state.value.idleDeadlineMs).isNull()
    }

    @Test
    fun `the window opens 30 s long once the reply is done`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, hello")

        manager.onTTSAndStreamingIdle()

        assertThat(manager.state.value.idleDeadlineMs).isEqualTo(now + VoiceInteractionManager.IDLE_TIMEOUT_MS)
    }

    @Test
    fun `talking holds the window shut, and it reopens full when the talking is over`() {
        manager.setVoiceMode(true)
        manager.handleTranscript("Kurisu, hello")
        manager.onTTSAndStreamingIdle()

        now += 20_000
        manager.setUserTalking(true)
        assertThat(manager.state.value.idleDeadlineMs).isNull()

        now += 5_000
        manager.setUserTalking(false)
        assertThat(manager.state.value.idleDeadlineMs).isEqualTo(now + VoiceInteractionManager.IDLE_TIMEOUT_MS)
    }

    @Test
    fun `talking outside an interaction opens no window`() {
        manager.setVoiceMode(true)

        manager.setUserTalking(true)
        manager.setUserTalking(false)

        assertThat(manager.state.value.idleDeadlineMs).isNull()
    }

    @Test
    fun `the state flow reports an interaction starting and ending`() = runTest {
        manager.setVoiceMode(true)
        manager.state.test {
            assertThat(awaitItem().interactionActive).isFalse()
            manager.handleTranscript("Kurisu, hi")
            assertThat(expectMostRecentItem().interactionActive).isTrue()
            manager.endInteraction()
            assertThat(expectMostRecentItem().interactionActive).isFalse()
        }
    }
}
