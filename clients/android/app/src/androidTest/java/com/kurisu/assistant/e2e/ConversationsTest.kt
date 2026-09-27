package com.kurisu.assistant.e2e

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Getting back into a conversation, and the slash commands that end one:
 * `/clear` starts a new one and keeps the old, `/delete` removes it (#310).
 */
@RunWith(AndroidJUnit4::class)
class ConversationsTest : E2eTest() {

    /** Send, wait for the reply, and return the mock's id for the conversation. */
    private fun converse(prefix: String): Pair<String, String> {
        val text = send(prefix)
        waitUntilViewShows("mock backend.")
        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        return text to conversation.string("id")!!
    }

    private fun slash(command: String) {
        type(command)
        composeRule.onNodeWithContentDescription("Send").performClick()
    }

    @Test
    fun a_conversation_opens_again_from_the_chats_list() {
        login()
        openChat()
        val (text, id) = converse("Remember this line")
        // Every mock conversation is titled alike; name this one so its row can be found.
        val title = unique("Reopen me")
        mock.patch("/conversations/$id", """{"title":"$title"}""")

        openDrawerItem("Chats")
        composeRule.onNodeWithContentDescription("Refresh").performClick()
        waitForText(title)
        composeRule.onNodeWithText(title).performClick()

        waitForText(text)
    }

    @Test
    fun clear_starts_a_new_conversation_and_leaves_the_old_one_alone() {
        login()
        openChat()
        val (_, before) = converse("Before clearing")

        slash("/clear")
        // The cleared chat first, as a person would see it before typing again:
        // typed straight after, the next message raced the clear on CI.
        waitForText("Send a message to start")
        val (_, after) = converse("After clearing")

        assertNotEquals(before, after)
        assert(mock.conversation(before) != null) { "the cleared conversation is still on the server" }
    }

    @Test
    fun delete_asks_first_and_then_removes_the_conversation() {
        login()
        openChat()
        val (_, id) = converse("Delete me")

        slash("/delete")
        waitForText("Delete this conversation?")
        composeRule.onNode(hasText("Delete") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        waitUntilGone("Delete this conversation?")

        waitUntilTrue { mock.conversation(id) == null }
        assertNull("conversation $id is gone from the server", mock.conversation(id))
    }
}
