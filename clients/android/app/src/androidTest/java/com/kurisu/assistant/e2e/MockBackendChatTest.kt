package com.kurisu.assistant.e2e

import android.Manifest
import android.content.Context
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.AmbiguousViewMatcherException
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.MainActivity
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.hamcrest.CoreMatchers.containsString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * The real app, end to end, against the standalone mock backend (#126).
 *
 * Start the mock first, from `clients/desktop`:
 *
 *     npm run mock:backend -- --host 0.0.0.0 --port 15597
 *
 * The emulator reaches the host at 10.0.2.2, which is what
 * [BuildConfig.MOCK_BACKEND_URL] holds in the dev flavour (override with
 * `-PmockBackendUrl=`). The `default` scenario is assumed: two personas,
 * Kurisu answering, a short streamed reply. Nothing here needs a model.
 *
 * Each test runs in its own process with the app's data wiped (the test
 * orchestrator, `clearPackageData`): the voice service and the per-persona
 * conversation cache are process-wide, and a second test in the same process
 * inherited the first one's conversation.
 *
 * Client tests run against the mock, never a deployed backend. When the mock
 * and `backend/kurisuassistant/` disagree, the backend wins and the mock is
 * fixed in the same PR as the protocol change.
 */
@RunWith(AndroidJUnit4::class)
class MockBackendChatTest {

    @get:Rule
    val composeRule = createEmptyComposeRule()

    // The chat screens ask for the microphone on entry; a system permission
    // dialog on top of the app would pause it mid-test.
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.CAMERA,
        Manifest.permission.POST_NOTIFICATIONS,
    )

    private val mockUrl = BuildConfig.MOCK_BACKEND_URL.trimEnd('/')
    private val http = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun freshInstallPointedAtTheMock() {
        if (mockUrl.isBlank()) fail("MOCK_BACKEND_URL is empty: run this suite on the dev flavour")
        requireMockReachable()

        val context = ApplicationProvider.getApplicationContext<Context>()
        runBlocking {
            // The app reads the stored URL before its first request; a session
            // from an earlier test must not skip the login form.
            PreferencesDataStore(context).apply {
                setBackendUrl(mockUrl)
                setRememberMe(false)
                // The Chats screen starts the voice service on entry and, with
                // this on, it records straight away and animates the mic strip
                // forever — and a never-idle screen is one the test cannot query.
                setAsrAlwaysListen(false)
                clearAllPersonaConversations()
            }
            EncryptedPreferences(context).apply {
                clearToken()
                clearRefreshToken()
            }
        }
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun tearDown() {
        scenario?.close()
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
        val conversation = waitForMockConversation(containing = text) { conv ->
            conv.messagesAfter(text).any { it.role == "assistant" }
        }
        val tail = conversation.messagesAfter(text)
        assertEquals(listOf("assistant"), tail.map { it.role })
        assertEquals("the reply is spoken by the conversation's persona",
            conversation["persona_id"]!!.jsonPrimitive.content, tail.single().personaId)

        waitUntilViewShows("mock backend.")
    }

    @Test
    fun the_chat_header_switches_persona_for_this_conversation_only() {
        login()
        openChat()
        val text = send("Who is there?")
        val before = waitForMockConversation(containing = text) { conv ->
            conv.messagesAfter(text).isNotEmpty()
        }
        // Only once the client has shown the reply has it processed `done` and
        // learned the conversation id — a switch before that is held for the
        // next message instead of written to the server.
        waitUntilViewShows("mock backend.")
        val conversationId = before["id"]!!.jsonPrimitive.content
        // Whichever of the two personas is not answering is the one to switch to.
        val (targetId, targetName) =
            if (before["persona_id"]!!.jsonPrimitive.content == "1") "2" to "Amadeus" else "1" to "Kurisu"

        // The header names who is answering; tapping it opens the persona sheet,
        // where the other persona is listed.
        composeRule.onNodeWithContentDescription("Switch persona").performClick()
        waitForText(targetName)
        composeRule.onNodeWithText(targetName).performClick()
        waitForText("$targetName answers this chat")

        // Persisted server-side without sending a message, and only for this
        // conversation: the assistant's default is untouched.
        val rebound = waitForMockConversation(containing = text) { conv ->
            conv["persona_id"]?.jsonPrimitive?.content == targetId
        }
        assertEquals(conversationId, rebound["id"]!!.jsonPrimitive.content)
        composeRule.waitUntil(UI_TIMEOUT_MS) {
            composeRule.onAllNodesWithText(targetName).fetchSemanticsNodes().isNotEmpty()
        }
        val assistant = json.parseToJsonElement(get("/assistant")).jsonObject
        assertEquals("1", assistant["default_persona_id"]!!.jsonPrimitive.content)
    }

    // --- driving the app ---

    /**
     * `waitUntil` over a semantics query. Between the activity launching and its
     * first composition there is no Compose root at all, and the query throws
     * rather than returning nothing; that moment is "not yet", not a failure.
     *
     * Queries the unmerged tree: Material3's extended FAB puts its label under
     * `clearAndSetSemantics`, so "New chat" is invisible to a merged-tree text
     * query while plainly on screen.
     */
    private fun waitForText(text: String) {
        var lastError: Throwable? = null
        try {
            composeRule.waitUntil(UI_TIMEOUT_MS) {
                try {
                    composeRule.onAllNodesWithText(text, useUnmergedTree = true)
                        .fetchSemanticsNodes().isNotEmpty()
                } catch (t: Throwable) {
                    lastError = t
                    false
                }
            }
        } catch (e: ComposeTimeoutException) {
            if (lastError != null) e.addSuppressed(lastError)
            throw AssertionError(
                "\"$text\" never appeared within ${UI_TIMEOUT_MS}ms" +
                    (lastError?.let { " (last query error: $it)" } ?: "") + ". On screen:\n${dumpScreen()}",
                e,
            )
        }
    }

    /** What is on screen is the whole diagnosis on a headless emulator. */
    private fun dumpScreen(): String = runCatching {
        composeRule.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes()
            .indices.joinToString("\n") { i ->
                composeRule.onAllNodes(isRoot(), useUnmergedTree = true)[i].printToString()
            }
    }.getOrElse { "(no compose roots: ${it.message})" }

    private fun login() {
        waitForText("Username")
        composeRule.onNodeWithText("Username").performTextInput("tester")
        composeRule.onNodeWithText("Password").performTextInput("password")
        // "Login" is both the mode toggle (a selectable segmented button) and
        // the submit button; only the submit is a plain clickable.
        composeRule.onNode(hasText("Login") and hasClickAction() and !isSelectable()).performClick()
        waitForText("New chat")
    }

    /**
     * "New chat" opens the persona's latest conversation when there is one,
     * rather than a blank transcript — so nothing here assumes a fresh
     * conversation; each message is unique and found by its text.
     */
    private fun openChat() {
        // The tap lands on the label's coordinates, which the FAB owns.
        composeRule.onNodeWithText("New chat", useUnmergedTree = true).performClick()
        waitForText("Message...")
    }

    /** Types and sends `prefix` made unique, returning the text that was sent. */
    private fun send(prefix: String): String {
        val text = "$prefix #${System.currentTimeMillis() % 100_000}"
        composeRule.onNodeWithText("Message...").performTextInput(text)
        composeRule.onNodeWithContentDescription("Send").performClick()
        return text
    }

    /** Espresso sees the TextView Markwon renders into; Compose semantics do not. */
    private fun waitUntilViewShows(fragment: String) {
        val deadline = System.currentTimeMillis() + UI_TIMEOUT_MS
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                onView(withText(containsString(fragment))).check(matches(isDisplayed()))
                return
            } catch (_: AmbiguousViewMatcherException) {
                return // more than one reply on screen says the same thing: it is there
            } catch (t: Throwable) {
                last = t
                Thread.sleep(250)
            }
        }
        throw AssertionError("no view showing \"$fragment\" within ${UI_TIMEOUT_MS}ms", last)
    }

    // --- reading the mock back ---

    private fun requireMockReachable() {
        try {
            val version = json.parseToJsonElement(get("/version")).jsonObject
            assertTrue(version.containsKey("wire_protocol"))
        } catch (e: Exception) {
            fail(
                "mock backend not reachable at $mockUrl (${e.message}). Start it from clients/desktop " +
                    "with: npm run mock:backend -- --host 0.0.0.0 --port 15597",
            )
        }
    }

    private fun get(path: String): String {
        val response = http.newCall(Request.Builder().url("$mockUrl$path").build()).execute()
        response.use {
            if (!it.isSuccessful) throw IllegalStateException("GET $path -> ${it.code}")
            return it.body!!.string()
        }
    }

    private class StoredMessage(val role: String, val content: String, val personaId: String?)

    private fun JsonObject.messages(): List<StoredMessage> =
        this["messages"]!!.jsonArray.map { m ->
            val o = m.jsonObject
            StoredMessage(
                role = o["role"]!!.jsonPrimitive.content,
                content = o["content"]!!.jsonPrimitive.content,
                personaId = o["persona_id"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
            )
        }

    /** The messages stored after the user message that reads exactly `text`. */
    private fun JsonObject.messagesAfter(text: String): List<StoredMessage> {
        val all = messages()
        val at = all.indexOfFirst { it.role == "user" && it.content == text }
        return if (at < 0) emptyList() else all.drop(at + 1)
    }

    /**
     * The mock conversation holding the user message `containing`, once
     * `predicate` holds for it — the mock lists conversations, and each is
     * fetched in full because the list carries no transcript.
     */
    private fun waitForMockConversation(containing: String, predicate: (JsonObject) -> Boolean): JsonObject {
        val deadline = System.currentTimeMillis() + UI_TIMEOUT_MS
        var seen: JsonObject? = null
        while (System.currentTimeMillis() < deadline) {
            val ids = json.parseToJsonElement(get("/conversations")).jsonArray
                .map { it.jsonObject["id"]!!.jsonPrimitive.content }
            for (id in ids.reversed()) {
                val full = json.parseToJsonElement(get("/conversations/$id")).jsonObject
                if (full.messages().none { it.role == "user" && it.content == containing }) continue
                seen = full
                if (predicate(full)) return full
            }
            Thread.sleep(250)
        }
        throw AssertionError(
            "no mock conversation holding \"$containing\" reached the expected state; last seen: $seen. " +
                "On screen:\n${dumpScreen()}",
        )
    }

    private companion object {
        const val UI_TIMEOUT_MS = 30_000L
    }
}
