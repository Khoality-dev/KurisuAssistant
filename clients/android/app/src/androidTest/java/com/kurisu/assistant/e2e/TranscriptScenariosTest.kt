package com.kurisu.assistant.e2e

import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith

/*
 * What a turn can hold besides text, each against the mock scenario that
 * scripts it (#310): a tool call on the rail, a step delegated to a
 * sub-agent, a handoff between personas, and a thinking block. A scenario is
 * fixed per mock process, so each is its own class; MockBackend says where
 * each one listens.
 */

@RunWith(AndroidJUnit4::class)
class ToolCallTest : E2eTest() {
    override val scenario = "tool-call"

    @Test
    fun a_tool_call_sits_on_the_rail_between_the_two_parts_of_the_answer() {
        login()
        openChat()
        val text = send("Look the answer up")

        waitUntilViewShows("The result is 42.")
        waitUntilViewShows("Let me check.")
        waitForText("lookup")
        waitForDescription("succeeded")

        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).size == 3
        }
        assertEquals(listOf("assistant", "tool", "assistant"), conversation.messagesAfter(text).map { it.role })
    }
}

@RunWith(AndroidJUnit4::class)
class SubAgentTest : E2eTest() {
    override val scenario = "sub-agent"

    @Ignore("#327: tool_kind is stream-only, so the tag is gone once the finished turn is reloaded")
    @Test
    fun a_step_delegated_to_a_sub_agent_is_tagged_with_its_name() {
        login()
        openChat()
        send("Ask the researcher")

        waitUntilViewShows("Nothing new, then.")
        waitForText("sub-agent")
        waitForText("Researcher")
    }
}

@RunWith(AndroidJUnit4::class)
class HandoffTest : E2eTest() {
    override val scenario = "handoff"

    @Test
    fun a_handoff_mid_answer_splits_it_into_two_speakers() {
        login()
        openChat()
        val text = send("Both of you")

        waitUntilViewShows("Kurisu speaking.")
        waitUntilViewShows("Amadeus speaking.")
        // The second bubble is signed by the persona that took over.
        waitForText("Amadeus")

        val conversation = mock.waitForConversation(text, onTimeout = ::dumpScreen) { conv ->
            conv.messagesAfter(text).size == 2
        }
        assertEquals(listOf("1", "2"), conversation.messagesAfter(text).map { it.personaId })
    }
}

@RunWith(AndroidJUnit4::class)
class ThinkingTest : E2eTest() {
    override val scenario = "thinking"

    @Test
    fun thinking_is_collapsed_under_its_label_and_opens_on_tap() {
        login()
        openChat()
        send("Think first")

        waitUntilViewShows("Final answer is X.")
        waitForText("Thinking")
        waitUntilGone("Let me consider this carefully.")

        composeRule.onNodeWithText("Thinking", useUnmergedTree = true).performClick()
        waitForText("Let me consider this carefully.", substring = true)
    }
}
