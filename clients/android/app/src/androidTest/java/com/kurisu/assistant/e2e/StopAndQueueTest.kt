package com.kurisu.assistant.e2e

import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Stopping a reply partway, and a message sent while one streams, against the
 * `slow` scenario: twenty words, one every 400 ms (#310).
 */
@RunWith(AndroidJUnit4::class)
class StopAndQueueTest : E2eTest() {
    override val scenario = "slow"

    @Test
    fun stop_keeps_what_had_arrived_and_the_rest_never_comes() {
        login()
        openChat()
        val text = send("Tell me a long story")

        waitUntilViewShows("word2")
        composeRule.onNodeWithContentDescription("Stop").performClick()
        waitForDescription("Send")

        // Well past when the rest would have arrived.
        pause(3_000)
        assertTrue("the partial reply is still on screen", viewShows("word2"))
        assertFalse("nothing arrives after Stop", viewShows("word20"))

        val stored = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }.messagesAfter(text).single { it.role == "assistant" }.content
        assertTrue("the server kept the partial reply: $stored", stored.contains("word1"))
        assertFalse("the server stopped too: $stored", stored.contains("word20"))
    }

    @Ignore("#326: the Android composer offers only Stop while a reply streams, so nothing can be sent to queue")
    @Test
    fun a_message_sent_while_a_reply_streams_waits_its_turn_and_is_then_sent() {
        login()
        openChat()
        send("First question")
        waitUntilViewShows("word1")

        val second = send("Second question")
        waitForText("Queued")

        // Sent once the first reply is done: twenty words, then its own twenty.
        val conversation = mock.waitForConversation(second, timeoutMs = 60_000, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(second).any { it.role == "assistant" && it.content.contains("word20") }
        }
        assertTrue(conversation.messagesAfter(second).isNotEmpty())
        waitUntilGone("Queued")
    }
}
