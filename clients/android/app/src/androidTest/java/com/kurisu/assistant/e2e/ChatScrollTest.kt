package com.kurisu.assistant.e2e

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Where the transcript rests once a conversation no longer fits the screen
 * (#332): at its end when it is opened and after the user's own send,
 * following a reply as it streams in — and left where the user scrolled to
 * when they went up to read. Against `long-conversation`: Kurisu's
 * conversation already runs to forty messages, and the reply is taller than
 * the screen.
 *
 * "At its end" is asked of the list itself rather than of a message: the mock
 * keeps state for the whole run, so which reply is the latest depends on the
 * tests before, and every reply reads alike.
 */
@RunWith(AndroidJUnit4::class)
class ChatScrollTest : E2eTest() {
    override val scenario = "long-conversation"

    @Test
    fun opening_a_long_conversation_shows_its_latest_messages() {
        login()
        openChat()

        waitUntilAtEnd("the conversation opened")
    }

    @Test
    fun the_users_own_message_is_shown_and_its_reply_followed_after_scrolling_up_to_read() {
        login()
        openChat()
        waitUntilAtEnd("the conversation opened")
        scrollUpToRead()
        assertFalse("the swipes left the end of the transcript", atEnd())

        val text = send("Where were we?")

        waitUntilDisplayed(text)
        replyStored(text)
        waitUntilAtEnd("the reply finished")
    }

    @Test
    fun scrolling_up_while_a_reply_streams_is_not_undone() {
        login()
        openChat()
        waitUntilAtEnd("the conversation opened")
        val text = send("Tell me everything")
        waitUntilViewShows("Line 3 of")

        scrollUpToRead()

        replyStored(text)
        // The finished reply, reloaded from the server, lands where the stream was.
        pause(2_000)
        assertFalse("the reply pulled the transcript back down to its end", atEnd())
    }

    /** Two swipes down the transcript: well up from its end, as a person reading back would. */
    private fun scrollUpToRead() {
        repeat(2) {
            composeRule.onNode(hasScrollToIndexAction()).performTouchInput { swipeDown() }
        }
    }

    /** The whole reply has been streamed, once the mock has stored it. */
    private fun replyStored(text: String) {
        mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
    }

    /**
     * Nothing below the last line. A lazy list's scroll range is an estimate
     * while it can scroll further, and its maximum is the current offset
     * exactly when it cannot.
     */
    private fun atEnd(): Boolean = runCatching {
        val range = composeRule.onNode(hasScrollToIndexAction()).fetchSemanticsNode()
            .config[SemanticsProperties.VerticalScrollAxisRange]
        range.value() >= range.maxValue()
    }.getOrDefault(false)

    private fun waitUntilAtEnd(after: String) {
        if (!waitUntilTrue { atEnd() }) {
            FailureEvidence.capture("not at the end after $after")
            throw AssertionError("the transcript is not at its end after $after. On screen:\n${dumpScreen()}")
        }
    }

    private fun waitUntilDisplayed(text: String) {
        waitForText(text)
        val shown = waitUntilTrue {
            val nodes = composeRule.onAllNodesWithText(text, useUnmergedTree = true)
            runCatching { nodes.fetchSemanticsNodes().indices.any { nodes[it].isDisplayed() } }.getOrDefault(false)
        }
        if (!shown) {
            FailureEvidence.capture("$text never on screen")
            throw AssertionError("\"$text\" is in the transcript but never on screen. On screen:\n${dumpScreen()}")
        }
    }
}
