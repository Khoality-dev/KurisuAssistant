package com.kurisu.assistant.e2e

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A new account's onboarding (#342), which asks only for the model (#376),
 * against an account just registered: no provider, model, persona or wake
 * word. The one screen connects Ollama, picks its model and opens the chat —
 * and the server holds the model and nothing else. The mock keeps state for
 * the run, so this one test takes the whole path; skipping and a cloud
 * provider are the unit tests' and the desktop e2e's.
 */
@RunWith(AndroidJUnit4::class)
class OnboardingTest : E2eTest() {
    override val scenario = "new-account"

    private fun field(label: String) = composeRule.onNode(hasSetTextAction() and hasText(label))

    @Test
    fun a_new_account_picks_its_model_and_the_chat_opens() {
        fillLoginForm()
        composeRule.onNode(hasText("Login") and hasClickAction() and !isSelectable()).performClick()
        waitForText("Start chatting")
        // The model is the whole of it: no steps after it.
        composeRule.onAllNodesWithText("Next").assertCountEquals(0)
        composeRule.onNodeWithText("Start chatting").assertIsNotEnabled()

        field("Ollama address").performTextInput("http://192.168.1.20:11434")
        composeRule.onNodeWithText("Connect").performClick()
        waitForText("Connected · 1 model")
        waitForText("test-model")
        composeRule.onNodeWithText("Start chatting").performClick()

        // The first conversation opens.
        waitForText("Message...")

        assertEquals(0, mock.getJson("/personas").jsonArray.size)
        val assistant = mock.getJson("/assistant").jsonObject
        assertEquals("test-model", assistant.string("model_name"))
        assertEquals(JsonNull, assistant.getValue("selected_persona_id"))
        assertEquals(JsonNull, assistant.getValue("trigger_word"))
        assertFalse(mock.getJson("/users/me").jsonObject.getValue("onboarding_pending").jsonPrimitive.boolean)
    }
}
