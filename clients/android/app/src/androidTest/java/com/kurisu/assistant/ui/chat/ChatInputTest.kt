package com.kurisu.assistant.ui.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.kurisu.assistant.ui.theme.KurisuTheme
import org.junit.Rule
import org.junit.Test

/**
 * End-to-end UI tests for the chat composer.
 *
 * These exercise the same ChatInput composable used in production, driven by test-owned
 * state so we can assert both rendering and callback side effects without a ViewModel.
 */
class ChatInputTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun send_button_is_disabled_when_input_is_blank() {
        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "",
                    onTextChange = {},
                    onSend = {},
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = false,
                    isInteractionMode = false,
                )
            }
        }

        composeRule.onNodeWithContentDescription("Send").assertIsNotEnabled()
    }

    @Test
    fun typing_text_enables_send_button_and_invokes_onSend() {
        var current by mutableStateOf("")
        var sendCount = 0

        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = current,
                    onTextChange = { current = it },
                    onSend = { sendCount++ },
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = false,
                    isInteractionMode = false,
                )
            }
        }

        // Placeholder visible on empty state
        composeRule.onNodeWithText("Message...").assertExists()

        // Type and send
        composeRule.onNodeWithText("Message...").performTextInput("hello there")
        composeRule.onNodeWithContentDescription("Send").assertIsEnabled()
        composeRule.onNodeWithContentDescription("Send").performClick()

        assert(sendCount == 1) { "Expected onSend to fire once, got $sendCount" }
    }

    @Test
    fun streaming_shows_stop_button_and_fires_cancel() {
        var cancelCount = 0

        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "pretending to send",
                    onTextChange = {},
                    onSend = {},
                    onCancel = { cancelCount++ },
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = true,
                    isInteractionMode = false,
                )
            }
        }

        composeRule.onNodeWithContentDescription("Stop").assertExists()
        composeRule.onNodeWithContentDescription("Stop").performClick()
        assert(cancelCount == 1) { "Expected onCancel to fire once, got $cancelCount" }
    }

    @Test
    fun streaming_disables_attach_button() {
        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "",
                    onTextChange = {},
                    onSend = {},
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = true,
                    isInteractionMode = false,
                )
            }
        }

        composeRule.onNodeWithContentDescription("Attach").assertIsNotEnabled()
    }

    @Test
    fun voice_bar_shows_copy_countdown_and_stop_control() {
        var stopCount = 0
        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "",
                    onTextChange = {},
                    onSend = {},
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = false,
                    isInteractionMode = true,
                    voiceIdleDeadlineMs = System.currentTimeMillis() + 27_000L,
                    onStopVoice = { stopCount++ },
                )
            }
        }

        composeRule.onNodeWithText("Voice active — sends when you stop").assertExists()
        // 27s remaining, rounded up — the bar counts down from the deadline.
        composeRule.onNodeWithText("idle timeout in 27s").assertExists()
        composeRule.onNodeWithContentDescription("Stop voice mode").performClick()
        assert(stopCount == 1) { "Expected onStopVoice to fire once, got $stopCount" }
    }

    @Test
    fun voice_bar_is_absent_outside_interaction_mode() {
        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "",
                    onTextChange = {},
                    onSend = {},
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = false,
                    isInteractionMode = false,
                )
            }
        }
        composeRule.onNodeWithText("Voice active — sends when you stop").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Stop voice mode").assertDoesNotExist()
    }
}
