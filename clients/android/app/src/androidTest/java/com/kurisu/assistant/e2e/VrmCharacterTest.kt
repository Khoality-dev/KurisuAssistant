package com.kurisu.assistant.e2e

import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import android.view.View
import android.webkit.WebView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import org.hamcrest.Matcher
import java.util.concurrent.atomic.AtomicReference
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A VRM persona's character on the phone (#246): the sheet hosts the character
 * page in a WebView, the page is handed the persona's config over the bridge,
 * asks for the model at the config's own URL, and Kotlin answers it with a
 * download the mock only serves to a bearer token the page never saw. The
 * page says how far it got in `document.documentElement.dataset.status`, and
 * "ready" is after the model was parsed and the first frame drawn.
 *
 * The emulator draws WebGL in software, so this is slow but real.
 */
@RunWith(AndroidJUnit4::class)
class VrmCharacterTest : E2eTest() {
    override val scenario = "vrm"

    /**
     * Run [script] in the page as its host does. The page's CSP has no
     * 'unsafe-eval', which refuses espresso-web's atoms; `evaluateJavascript`
     * is the embedder's own call and is not subject to it.
     */
    private fun evaluate(script: String): String? {
        val result = AtomicReference<String?>(null)
        val done = AtomicReference(false)
        runCatching {
            onView(isAssignableFrom(WebView::class.java)).perform(object : ViewAction {
                override fun getConstraints(): Matcher<View> = isAssignableFrom(WebView::class.java)
                override fun getDescription() = "evaluate a script in the character page"
                override fun perform(uiController: UiController, view: View) {
                    (view as WebView).evaluateJavascript(script) { value ->
                        result.set(value)
                        done.set(true)
                    }
                }
            })
        }.onFailure { return "(${it.javaClass.simpleName}: ${it.message?.take(200)})" }
        waitUntilTrue(timeoutMs = 5_000) { done.get() }
        // The result is the script's value as JSON: a string comes back quoted.
        return result.get()?.takeUnless { it == "null" }?.removeSurrounding("\"")
    }

    private fun pageStatus(): String? = evaluate("document.documentElement.dataset.status || null")

    /** Where the page got to, for a failure message. */
    private fun pageState(): String? = evaluate(
        "[location.href, document.readyState, String(!!window.__kurisu), " +
            "JSON.stringify((window.__kurisu && window.__kurisu.events) || null), " +
            "(document.body && document.body.innerText || '').slice(0, 200)].join(' | ')",
    )

    @Test
    fun the_sheet_shows_the_persona_s_3d_model() {
        login()
        openChat()
        composeRule.onNodeWithContentDescription("More").performClick()
        waitForText("Live character")
        composeRule.onNodeWithText("Live character").performClick()

        var last: String? = null
        val ready = waitUntilTrue(timeoutMs = 60_000) {
            last = pageStatus()
            last == "ready"
        }
        if (!ready) dumpScreen()
        assertEquals("the character page's status (${pageState()})", "ready", last)
    }
}
