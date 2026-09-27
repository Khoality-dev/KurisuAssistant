package com.kurisu.assistant.e2e

import android.content.Context
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Staying signed in, and signing out (#310).
 *
 * A test cannot restart its own process, and relaunching the activity keeps
 * the in-memory session either way — so what is checked is what a cold start
 * reads (`AuthRepository.initializeAuth`): the stored token and the
 * remember-me flag.
 */
@RunWith(AndroidJUnit4::class)
class SessionTest : E2eTest() {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun storedToken() = EncryptedPreferences(context).getToken()
    private fun rememberMe() = runBlocking { PreferencesDataStore(context).getRememberMe() }

    private fun waitForStored(expectToken: Boolean) {
        waitUntilTrue { (storedToken() != null) == expectToken }
    }

    @Test
    fun remember_me_is_on_by_default_and_keeps_the_session_for_the_next_launch() {
        fillLoginForm()
        composeRule.onNode(isToggleable()).assertIsOn()
        submitLogin()

        waitForStored(expectToken = true)
        assertNotNull("the token is stored for the next launch", storedToken())
        assertEquals(true, rememberMe())
        relaunch()
        waitForText("New chat")
    }

    @Test
    fun without_remember_me_nothing_is_kept_for_the_next_launch() {
        fillLoginForm()
        // The login form's only toggle; the Login/Register switch is selectable, not toggleable.
        composeRule.onNode(isToggleable()).performClick()
        composeRule.onNode(isToggleable()).assertIsOff()
        submitLogin()
        assertNull("no token is stored", storedToken())
        assertEquals(false, rememberMe())
    }

    @Test
    fun logout_asks_first_and_returns_to_the_login_form() {
        login()
        waitForStored(expectToken = true)

        openDrawerItem("Logout")
        waitForText("Are you sure you want to logout?")
        composeRule.onNode(hasText("Logout") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        waitForText("Username")
        waitForStored(expectToken = false)
        assertNull("signing out forgets the stored token", storedToken())
    }
}
