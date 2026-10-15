package com.kurisu.assistant.e2e

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Login, a streamed reply, and the header's persona switch, against the
 * `default` scenario: two personas, Kurisu in use, a short reply (#126).
 *
 * The switch is the account's (#354): it changes who answers every conversation,
 * so a test that makes it puts the mock's selection back, or the next test on the
 * same mock would start with someone else answering.
 */
@RunWith(AndroidJUnit4::class)
class MockBackendChatTest : E2eTest() {

    private fun selectedPersonaId(): String? = mock.getJson("/assistant").jsonObject.string("selected_persona_id")

    private fun restoreSelection(id: String?) {
        mock.patch("/assistant", """{"selected_persona_id": ${id ?: "null"}}""")
    }

    @Test
    fun login_send_and_the_streamed_reply_lands_in_the_transcript() {
        login()
        openChat()
        val text = send("Ping from the emulator")

        // The user's bubble is Compose text; the assistant's reply is rendered
        // by Markwon inside an AndroidView, which Compose semantics cannot see,
        // so it is checked through Espresso once the mock has stored a reply.
        // The bubble can render twice for a moment — the optimistic local copy
        // and the transcript reloaded from the server — so: at least one.
        waitForText(text)
        composeRule.onAllNodesWithText(text, useUnmergedTree = true).onFirst().assertIsDisplayed()
        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        val tail = conversation.messagesAfter(text)
        assertEquals(listOf("assistant"), tail.map { it.role })
        assertEquals("the reply is spoken by the persona in use",
            selectedPersonaId(), tail.single().personaId)

        waitUntilViewShows("mock backend.")
    }

    @Test
    fun switching_to_the_assistant_puts_no_persona_in_use() {
        val before = selectedPersonaId()
        try {
            login()
            openChat()

            composeRule.onNodeWithContentDescription("Switch persona").performClick()
            waitForText("No persona — the assistant answers as itself")
            composeRule.onNodeWithText("No persona — the assistant answers as itself").performClick()
            waitForText("Assistant answers every chat")
            assertTrue("the account has no persona in use", waitUntilTrue { selectedPersonaId() == null })
            val text = send("Just you, please")

            val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
                conv.messagesAfter(text).any { it.role == "assistant" }
            }
            assertEquals(listOf<String?>(null), conversation.messagesAfter(text).map { it.personaId })
        } finally {
            restoreSelection(before)
        }
    }

    @Test
    fun the_chat_header_switches_the_persona_in_use_for_every_chat() {
        val before = selectedPersonaId()
        try {
            login()
            openChat()
            val text = send("Who is there?")
            val first = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
                conv.messagesAfter(text).isNotEmpty()
            }
            // Only once the client has shown the reply has it processed `done` and
            // learned the conversation id.
            waitUntilViewShows("mock backend.")
            val conversationId = first.string("id")
            // Whichever of the two personas is not in use is the one to switch to.
            val (targetId, targetName) = if (before == "1") "2" to "Amadeus" else "1" to "Kurisu"

            composeRule.onNodeWithContentDescription("Switch persona").performClick()
            waitForText(targetName)
            composeRule.onNodeWithText(targetName).performClick()
            waitForText("$targetName answers every chat")

            // Saved to the account, with no message sent.
            assertTrue("the account's persona is $targetName", waitUntilTrue { selectedPersonaId() == targetId })

            // The open conversation stays open and continues as the new persona.
            val next = send("And now?")
            val after = mock.waitForConversation(next, onTimeout = ::dumpScreen) { conv ->
                conv.messagesAfter(next).any { it.role == "assistant" }
            }
            assertEquals(conversationId, after.string("id"))
            assertEquals(listOf(targetId), after.messagesAfter(next).filter { it.role == "assistant" }.map { it.personaId })
        } finally {
            restoreSelection(before)
        }
    }
}
