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

    /** Outermost, so a retry starts again from `@Before` with every other rule fresh. */
    @get:Rule(order = 0)
    val retryOnce = RetryOnce()

    @get:Rule(order = 1)
    val composeRule = createEmptyComposeRule()

    // The chat screens ask for the microphone on entry; a system permission
    // dialog on top of the app would pause it mid-test.
    @get:Rule(order = 2)
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
                // The mock answers `POST /tts` with no audio, so with autoplay on every
                // reply raises a "Speech failed" banner over the transcript. Speech is
                // not what these tests are about (it is checked by hand, CLAUDE.md).
                setTTSAutoPlay(false)
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
        try {
            composeRule.waitUntil(MockBackend.UI_TIMEOUT_MS) { viewShows(fragment) }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError(
                "no view showing \"$fragment\" within ${MockBackend.UI_TIMEOUT_MS}ms; text views on screen: ${shownTexts()}; " +
                    "diagnostics: ${viewDiagnostics()}\n${dumpScreen()}",
                e,
            )
        }
    }

    /**
     * Wait for a condition outside the UI — the mock's state, the app's storage —
     * with the app still rendering. Never a bare `Thread.sleep` loop: the Compose
     * rule owns the frame clock, and frames only advance while the test syncs
     * through it; a sleeping test froze the app on the frame before the send, so
     * no reply was ever composed and its Markwon view never existed (#310).
     */
    protected fun waitUntilTrue(timeoutMs: Long = MockBackend.UI_TIMEOUT_MS, condition: () -> Boolean): Boolean =
        try {
            composeRule.waitUntil(timeoutMs) { condition() }
            true
        } catch (e: ComposeTimeoutException) {
            false
        }

    /** Let `ms` of real time pass with the app rendering (a sleep that keeps frames coming). */
    protected fun pause(ms: Long) {
        val end = System.currentTimeMillis() + ms
        waitUntilTrue(ms + 10_000) { System.currentTimeMillis() >= end }
    }

    /** True when a TextView on screen shows `fragment` right now. */
    protected fun viewShows(fragment: String): Boolean = shownTexts().any { it.contains(fragment) }

    /** Every TextView in the scenario's activity, shown or not, and what that activity is doing. */
    private fun viewDiagnostics(): String {
        val out = StringBuilder()
        try {
            activity?.onActivity { act ->
                val all = mutableListOf<String>()
                fun walk(view: View) {
                    if (view is TextView) all += "${view.javaClass.simpleName}(shown=${view.isShown}, attached=${view.isAttachedToWindow}, text=${view.text.toString().take(40)})"
                    if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
                }
                walk(act.window.decorView)
                out.append("activity=${System.identityHashCode(act)} finishing=${act.isFinishing} hasFocus=${act.hasWindowFocus()} ")
                out.append("textViews=$all")
            } ?: out.append("no activity scenario")
            out.append(" state=${activity?.state}")
        } catch (e: Throwable) {
            out.append("onActivity threw ${e.javaClass.simpleName}: ${e.message}")
        }
        val resumed = mutableListOf<String>()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
            androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)
                .forEach { resumed += "${it.javaClass.simpleName}@${System.identityHashCode(it)}" }
        }
        out.append(" resumed=$resumed")
        return out.toString()
    }

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
