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
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Login, a streamed reply, and the header's persona switch, against the
 * `default` scenario: two personas, Kurisu answering, a short reply (#126).
 */
@RunWith(AndroidJUnit4::class)
class MockBackendChatTest : E2eTest() {

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
        assertEquals("the reply is spoken by the conversation's persona",
            conversation.string("persona_id"), tail.single().personaId)

        waitUntilViewShows("mock backend.")
    }

    @Test
    fun a_new_chat_can_be_the_assistants_own_while_a_default_persona_is_set() {
        login()
        openChat()
        // A chat that does not exist yet: the default scenario selects Kurisu.
        type("/clear")
        composeRule.onNodeWithContentDescription("Send").performClick()
        waitForText("Send a message to start")

        composeRule.onNodeWithContentDescription("Switch persona").performClick()
        waitForText("No persona — the assistant answers as itself")
        composeRule.onNodeWithText("No persona — the assistant answers as itself").performClick()
        waitForText("Assistant answers this chat")
        val text = send("Just you, please")

        // The server no longer slips the default in when nobody is named (#334).
        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        assertEquals(null, conversation.string("persona_id"))
        assertEquals(listOf<String?>(null), conversation.messagesAfter(text).map { it.personaId })
    }

    @Test
    fun the_chat_header_switches_persona_for_this_conversation_only() {
        login()
        openChat()
        val text = send("Who is there?")
        val before = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).isNotEmpty()
        }
        // Only once the client has shown the reply has it processed `done` and
        // learned the conversation id — a switch before that is held for the
        // next message instead of written to the server.
        waitUntilViewShows("mock backend.")
        val conversationId = before.string("id")
        // Whichever of the two personas is not answering is the one to switch to.
        val (targetId, targetName) =
            if (before.string("persona_id") == "1") "2" to "Amadeus" else "1" to "Kurisu"

        // The header names who is answering; tapping it opens the persona sheet,
        // where the other persona is listed.
        composeRule.onNodeWithContentDescription("Switch persona").performClick()
        waitForText(targetName)
        composeRule.onNodeWithText(targetName).performClick()
        waitForText("$targetName answers this chat")

        // Persisted server-side without sending a message, and only for this
        // conversation: the assistant's default is untouched.
        val rebound = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.string("persona_id") == targetId
        }
        assertEquals(conversationId, rebound.string("id"))
        waitForText(targetName)
        val assistant = mock.getJson("/assistant").jsonObject
        assertEquals("1", assistant.string("selected_persona_id"))
    }
}
