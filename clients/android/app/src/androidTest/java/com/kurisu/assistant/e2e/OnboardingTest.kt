package com.kurisu.assistant.e2e

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A new account's onboarding (#342), against an account just registered: no
 * provider, model, persona or wake word. The flow connects Ollama, picks its
 * model, makes a persona with a voice, keeps its name as the wake word, and
 * opens the chat — and the server holds all of it. The mock keeps state for
 * the run, so this one test takes the whole path; skipping and the persona-less
 * path are the unit tests' and the desktop e2e's.
 */
@RunWith(AndroidJUnit4::class)
class OnboardingTest : E2eTest() {
    override val scenario = "new-account"

    private fun field(label: String) = composeRule.onNode(hasSetTextAction() and hasText(label))

    @Test
    fun a_new_account_sets_up_its_model_persona_and_wake_word() {
        fillLoginForm()
        composeRule.onNode(hasText("Login") and hasClickAction() and !isSelectable()).performClick()
        waitForText("Step 1 of 5")

        // Model: connect the provider, and its model is picked.
        field("Ollama address").performTextInput("http://192.168.1.20:11434")
        composeRule.onNodeWithText("Connect").performClick()
        waitForText("Connected · 1 model")
        composeRule.onNodeWithText("Next").performClick()

        // Persona.
        waitForText("Step 2 of 5")
        field("Name").performTextInput("Kurisu")
        composeRule.onNodeWithText("Next").performClick()

        // Voice.
        waitForText("Step 3 of 5")
        composeRule.onNodeWithText("Kurisu (Japanese)").performClick()
        composeRule.onNodeWithText("Next").performClick()

        // Character: none for now.
        waitForText("Step 4 of 5")
        composeRule.onNodeWithText("None for now").performClick()
        composeRule.onNodeWithText("Next").performClick()

        // Wake word: the persona's name.
        waitForText("Step 5 of 5")
        waitForText("Say “Kurisu” in voice mode")
        composeRule.onNodeWithText("Start chatting").performClick()

        // The first conversation opens.
        waitForText("Message...")

        val personas = mock.getJson("/personas").jsonArray
        assertEquals(1, personas.size)
        val persona = personas.single().jsonObject
        assertEquals("Kurisu", persona.string("name"))
        assertEquals("kurisu_ja_01", persona.string("voice_reference"))

        val assistant = mock.getJson("/assistant").jsonObject
        assertEquals("test-model", assistant.string("model_name"))
        assertEquals(persona.getValue("id").jsonPrimitive.int, assistant.getValue("selected_persona_id").jsonPrimitive.int)
        assertEquals("Kurisu", assistant.string("trigger_word"))
        assertFalse(mock.getJson("/users/me").jsonObject.getValue("onboarding_pending").jsonPrimitive.boolean)
    }
}
