package com.kurisu.assistant.e2e

import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A brand-new account has no model chosen, so its first message is refused
 * with `NO_MODEL_SELECTED` (#149, #197): the banner offers the model sheet in
 * place, the refused message comes back to the composer, and once a model is
 * picked it goes through.
 *
 * Against the `no-model` scenario, and once per mock process: choosing the
 * model is the point of the test, and the mock remembers it. Restart that mock
 * to run this again locally.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunTest : E2eTest() {
    override val scenario = "no-model"

    @Test
    fun the_first_message_asks_for_a_model_and_goes_through_once_one_is_chosen() {
        login()
        openChat()
        val text = send("Hello for the first time")

        waitForText("Choose a model")
        composeRule.onNodeWithText("Choose a model").performClick()
        waitForText("test-model")
        composeRule.onNodeWithText("test-model").performClick()

        // The refused message is back in the composer, not lost.
        waitForText(text)
        composeRule.onNodeWithContentDescription("Send").performClick()

        waitUntilViewShows("mock backend.")
        mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        assertEquals("test-model", mock.getJson("/assistant").jsonObject.string("model_name"))
    }
}
