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
                )
            }
        }

        composeRule.onNodeWithContentDescription("Stop").assertExists()
        composeRule.onNodeWithContentDescription("Stop").performClick()
        assert(cancelCount == 1) { "Expected onCancel to fire once, got $cancelCount" }
    }

    /**
     * While a reply streams, the next message can still be sent: it waits its
     * turn in the queue, as on the desktop (#326). Stop stays beside it.
     */
    @Test
    fun streaming_keeps_send_beside_stop_so_the_next_message_can_queue() {
        var sendCount = 0

        composeRule.setContent {
            KurisuTheme {
                ChatInput(
                    text = "and another thing",
                    onTextChange = {},
                    onSend = { sendCount++ },
                    onCancel = {},
                    onImageSelected = {},
                    onRemoveImage = {},
                    selectedImages = emptyList(),
                    isStreaming = true,
                )
            }
        }

        composeRule.onNodeWithContentDescription("Stop").assertExists()
        composeRule.onNodeWithContentDescription("Send").assertIsEnabled()
        composeRule.onNodeWithContentDescription("Send").performClick()
        assert(sendCount == 1) { "Expected onSend to fire once, got $sendCount" }
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
                )
            }
        }

        composeRule.onNodeWithContentDescription("Attach").assertIsNotEnabled()
    }

}
