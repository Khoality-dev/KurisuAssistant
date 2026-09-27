package com.kurisu.assistant.e2e

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** An account with no persona at all: the assistant answers as itself (#302). */
@RunWith(AndroidJUnit4::class)
class NoPersonaTest : E2eTest() {
    override val scenario = "no-persona"

    @Test
    fun the_assistant_answers_as_itself() {
        login()
        openChat()
        val text = send("Anyone there?")

        waitUntilViewShows("mock backend.")
        waitForText("Assistant", substring = true)
        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        assertNull(conversation.string("persona_id"))
        assertNull(conversation.messagesAfter(text).single().personaId)
    }
}
