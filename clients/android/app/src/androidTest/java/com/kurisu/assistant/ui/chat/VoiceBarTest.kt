package com.kurisu.assistant.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.kurisu.assistant.domain.voice.VoiceBarPhase
import com.kurisu.assistant.ui.theme.KurisuTheme
import org.junit.Rule
import org.junit.Test

/**
 * The voice bar (#341), as section 3 of the Claude Design mockup "Kurisu - Voice
 * Mode v1" draws it: in place of the composer, the first line says what voice
 * mode is doing and the second what was last said; a problem says what is
 * wrong and offers the fix; End voice mode is in every state. The top-bar
 * control says whether voice mode is on, and carries a dot on a problem.
 */
class VoiceBarTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var ended = 0
    private var retried = 0
    private var openedAssistant = 0
    private var openedAppSettings = 0

    private fun show(
        phase: VoiceBarPhase,
        wakeWord: String? = "kurisu",
        lastTranscript: String? = "And for a firm one?",
        idleDeadlineMs: Long? = null,
    ) {
        composeRule.setContent {
            KurisuTheme {
                VoiceBar(
                    phase = phase,
                    wakeWord = wakeWord,
                    answererName = "Kurisu",
                    lastTranscript = lastTranscript,
                    idleDeadlineMs = idleDeadlineMs,
                    onEnd = { ended++ },
                    onRetry = { retried++ },
                    onOpenAssistant = { openedAssistant++ },
                    onOpenAppSettings = { openedAppSettings++ },
                )
            }
        }
    }

    @Test
    fun waiting_names_the_wake_word_and_says_nothing_is_sent() {
        show(VoiceBarPhase.WAITING)

        composeRule.onNodeWithText("Say “Kurisu” to start").assertIsDisplayed()
        composeRule.onNodeWithText("Nothing is sent until you say it.").assertIsDisplayed()
        composeRule.onNodeWithText("You said", substring = true).assertDoesNotExist()
    }

    @Test
    fun listening_shows_the_last_thing_said() {
        show(VoiceBarPhase.LISTENING)

        composeRule.onNodeWithText("Listening").assertIsDisplayed()
        composeRule.onNodeWithText("You said “And for a firm one?”").assertIsDisplayed()
    }

    @Test
    fun transcribing_holds_the_place_of_the_words() {
        show(VoiceBarPhase.TRANSCRIBING)

        composeRule.onNodeWithText("Transcribing").assertIsDisplayed()
        composeRule.onNodeWithText("You said", substring = true).assertDoesNotExist()
    }

    @Test
    fun thinking_and_speaking_name_who_answers() {
        show(VoiceBarPhase.THINKING)
        composeRule.onNodeWithText("Kurisu is thinking").assertIsDisplayed()
    }

    @Test
    fun speaking_names_who_answers() {
        show(VoiceBarPhase.SPEAKING)
        composeRule.onNodeWithText("Kurisu is speaking").assertIsDisplayed()
    }

    @Test
    fun the_window_says_it_ends_soon_with_no_countdown() {
        show(VoiceBarPhase.WINDOW, idleDeadlineMs = System.currentTimeMillis() + 19_000L)

        composeRule.onNodeWithText("Listening").assertIsDisplayed()
        composeRule.onNodeWithText("Ends soon unless you say something").assertIsDisplayed()
        composeRule.onNodeWithTag("voice-window-drain").assertExists()
        composeRule.onNodeWithText("idle timeout", substring = true).assertDoesNotExist()
    }

    @Test
    fun no_wake_word_leads_to_the_assistant_screen() {
        show(VoiceBarPhase.NO_WAKE_WORD)

        composeRule.onNodeWithText("No wake word set").assertIsDisplayed()
        composeRule.onNodeWithText("Voice mode can't start anything until you set one on the Assistant screen.").assertIsDisplayed()
        composeRule.onNodeWithText("Open Assistant").performClick()
        assert(openedAssistant == 1)
    }

    @Test
    fun an_unavailable_microphone_can_be_tried_again() {
        show(VoiceBarPhase.MIC_UNAVAILABLE)

        composeRule.onNodeWithText("Microphone unavailable").assertIsDisplayed()
        composeRule.onNodeWithText("Another app may be using it. Close it and try again.").assertIsDisplayed()
        composeRule.onNodeWithText("Try again").performClick()
        assert(retried == 1)
    }

    @Test
    fun blocked_access_opens_the_apps_android_settings() {
        show(VoiceBarPhase.MIC_BLOCKED)

        composeRule.onNodeWithText("Microphone access is off").assertIsDisplayed()
        composeRule.onNodeWithText("Allow it in Android settings to use voice mode.").assertIsDisplayed()
        composeRule.onNodeWithText("Open settings").performClick()
        assert(openedAppSettings == 1)
    }

    @Test
    fun speech_recognition_that_did_not_load_can_be_retried() {
        show(VoiceBarPhase.ASR_UNAVAILABLE)

        composeRule.onNodeWithText("Speech recognition didn't load").assertIsDisplayed()
        composeRule.onNodeWithText("Voice mode can't hear anything until it does.").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").performClick()
        assert(retried == 1)
    }

    @Test
    fun end_voice_mode_is_there_in_every_state() {
        var phase by mutableStateOf(VoiceBarPhase.WAITING)
        composeRule.setContent {
            KurisuTheme {
                VoiceBar(
                    phase = phase,
                    wakeWord = "kurisu",
                    answererName = "Kurisu",
                    lastTranscript = null,
                    idleDeadlineMs = null,
                    onEnd = { ended++ },
                    onRetry = {},
                    onOpenAssistant = {},
                    onOpenAppSettings = {},
                )
            }
        }
        for (p in VoiceBarPhase.entries) {
            ended = 0
            phase = p
            composeRule.onNodeWithText("End voice mode").performClick()
            assert(ended == 1) { "End voice mode did not fire in $p" }
        }
    }

    // ── The top-bar control ──────────────────────────────────────────────

    @Test
    fun the_top_bar_control_starts_and_ends_voice_mode_and_shows_a_dot_on_a_problem() {
        var on by mutableStateOf(false)
        var attention by mutableStateOf(false)
        composeRule.setContent {
            KurisuTheme {
                VoiceModeButton(on = on, attention = attention, onToggle = { on = !on })
            }
        }

        composeRule.onNodeWithContentDescription("Start voice mode").performClick()
        composeRule.onNodeWithContentDescription("End voice mode").assertIsDisplayed()
        composeRule.onNodeWithTag("voice-mode-attention").assertDoesNotExist()

        attention = true
        composeRule.onNodeWithTag("voice-mode-attention").assertExists()
    }

    // ── The new-conversation marker ──────────────────────────────────────

    @Test
    fun a_new_interaction_opens_on_a_marker_that_points_to_chats() {
        var openedChats = 0
        val at = java.util.Calendar.getInstance().apply { set(2026, 8, 28, 19, 42) }.timeInMillis
        composeRule.setContent {
            KurisuTheme {
                NewInteractionMarker(wakeWord = "kurisu", atMs = at, hasPrevious = true, onOpenChats = { openedChats++ })
            }
        }

        composeRule.onNodeWithText("New conversation").assertIsDisplayed()
        composeRule.onNodeWithText("You said “Kurisu” at", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("The last one is in", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Chats").performClick()
        assert(openedChats == 1)
    }
}
