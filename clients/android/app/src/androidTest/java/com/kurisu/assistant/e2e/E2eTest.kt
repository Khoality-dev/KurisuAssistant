package com.kurisu.assistant.e2e

import android.Manifest
import android.content.Context
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.rule.GrantPermissionRule
import com.kurisu.assistant.MainActivity
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Rule

/**
 * The real app, end to end, against a standalone mock backend (#126, #310).
 *
 * A subclass names the [scenario] its mock serves; [MockBackend] says where
 * that mock listens. Each test runs in its own process with the app's data
 * wiped (the test orchestrator, `clearPackageData`): the voice service and the
 * per-persona conversation cache are process-wide, and a second test in the
 * same process inherited the first one's conversation.
 *
 * Client tests run against the mock, never a deployed backend. When the mock
 * and `backend/kurisuassistant/` disagree, the backend wins and the mock is
 * fixed in the same PR as the protocol change.
 */
abstract class E2eTest {

    open val scenario: String = "default"

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

    protected val mock: MockBackend by lazy { MockBackend(scenario) }
    protected var activity: ActivityScenario<MainActivity>? = null

    @Before
    fun freshInstallPointedAtTheMock() {
        mock.requireReachable()
        val context = ApplicationProvider.getApplicationContext<Context>()
        runBlocking {
            // The app reads the stored URL before its first request; a session
            // from an earlier test must not skip the login form.
            PreferencesDataStore(context).apply {
                setBackendUrl(mock.url)
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
        activity = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun closeTheApp() {
        activity?.close()
    }

    /** Close and launch the activity again, as a user reopening the app would. */
    protected fun relaunch() {
        activity?.close()
        activity = ActivityScenario.launch(MainActivity::class.java)
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
    protected fun waitForText(text: String, substring: Boolean = false) =
        waitFor("\"$text\"") { composeRule.onAllNodesWithText(text, substring = substring, useUnmergedTree = true) }

    protected fun waitForDescription(description: String) =
        waitFor("a node described \"$description\"") {
            composeRule.onAllNodesWithContentDescription(description, useUnmergedTree = true)
        }

    protected fun waitForNode(what: String, matcher: SemanticsMatcher) =
        waitFor(what) { composeRule.onAllNodes(matcher, useUnmergedTree = true) }

    protected fun waitUntilGone(text: String) {
        try {
            composeRule.waitUntil(MockBackend.UI_TIMEOUT_MS) {
                runCatching {
                    composeRule.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()
                }.getOrDefault(false)
            }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("\"$text\" is still on screen. On screen:\n${dumpScreen()}", e)
        }
    }

    private fun waitFor(
        what: String,
        query: () -> androidx.compose.ui.test.SemanticsNodeInteractionCollection,
    ) {
        var lastError: Throwable? = null
        try {
            composeRule.waitUntil(MockBackend.UI_TIMEOUT_MS) {
                try {
                    query().fetchSemanticsNodes().isNotEmpty()
                } catch (t: Throwable) {
                    lastError = t
                    false
                }
            }
        } catch (e: ComposeTimeoutException) {
            if (lastError != null) e.addSuppressed(lastError)
            throw AssertionError(
                "$what never appeared within ${MockBackend.UI_TIMEOUT_MS}ms" +
                    (lastError?.let { " (last query error: $it)" } ?: "") + ". On screen:\n${dumpScreen()}",
                e,
            )
        }
    }

    /** What is on screen is the whole diagnosis on a headless emulator. */
    protected fun dumpScreen(): String = runCatching {
        composeRule.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes()
            .indices.joinToString("\n") { i ->
                composeRule.onAllNodes(isRoot(), useUnmergedTree = true)[i].printToString()
            }
    }.getOrElse { "(no compose roots: ${it.message})" }

    protected fun fillLoginForm() {
        waitForText("Username")
        composeRule.onNodeWithText("Username").performTextInput("tester")
        composeRule.onNodeWithText("Password").performTextInput("password")
    }

    protected fun submitLogin() {
        // "Login" is both the mode toggle (a selectable segmented button) and
        // the submit button; only the submit is a plain clickable.
        composeRule.onNode(hasText("Login") and hasClickAction() and !isSelectable()).performClick()
        waitForText("New chat")
    }

    protected fun login() {
        fillLoginForm()
        submitLogin()
    }

    /**
     * "New chat" opens the persona's latest conversation when there is one,
     * rather than a blank transcript — so nothing here assumes a fresh
     * conversation; each message is unique and found by its text.
     */
    protected fun openChat() {
        // The tap lands on the label's coordinates, which the FAB owns.
        composeRule.onNodeWithText("New chat", useUnmergedTree = true).performClick()
        waitForText("Message...")
    }

    /** A text no other test (or earlier run against the same mock) has sent. */
    protected fun unique(prefix: String) = "$prefix #${System.nanoTime() % 1_000_000_000}"

    /** Types and sends `prefix` made unique, returning the text that was sent. */
    protected fun send(prefix: String): String {
        val text = unique(prefix)
        type(text)
        composeRule.onNodeWithContentDescription("Send").performClick()
        return text
    }

    protected fun type(text: String) {
        composeRule.onNodeWithText("Message...").performTextInput(text)
    }

    /** From anywhere with a drawer: open it and pick an entry. */
    protected fun openDrawerItem(label: String) {
        composeRule.onNodeWithContentDescription("Menu").performClick()
        waitForText(label)
        composeRule.onNode(hasText(label) and hasClickAction(), useUnmergedTree = false).performClick()
    }

    /**
     * The assistant's reply is rendered by Markwon into a TextView inside an
     * AndroidView, which Compose semantics cannot see. It is found by walking
     * the activity's own view tree rather than through Espresso: Espresso looks
     * in the focused window, and a slow emulator's "System UI isn't responding"
     * dialog takes the focus while the app underneath is fine.
     */
    protected fun waitUntilViewShows(fragment: String) {
        val deadline = System.currentTimeMillis() + MockBackend.UI_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (viewShows(fragment)) return
            Thread.sleep(250)
        }
        throw AssertionError(
            "no view showing \"$fragment\" within ${MockBackend.UI_TIMEOUT_MS}ms; text views on screen: ${shownTexts()}\n${dumpScreen()}",
        )
    }

    /** True when a TextView on screen shows `fragment` right now. */
    protected fun viewShows(fragment: String): Boolean = shownTexts().any { it.contains(fragment) }

    private fun shownTexts(): List<String> {
        val texts = mutableListOf<String>()
        fun walk(view: View) {
            if (view is TextView && view.isShown) texts += view.text.toString()
            if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
        }
        activity?.onActivity { walk(it.window.decorView) }
        return texts
    }
}
