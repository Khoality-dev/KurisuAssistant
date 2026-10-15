package com.kurisu.assistant.data.push

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.DeviceRegistration
import com.kurisu.assistant.data.remote.api.KurisuApiService
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test

/**
 * The phone's registration for push (#353): while its notifications are on and
 * someone is signed in, the server has this app's FCM token; off, or signing
 * out, takes it away. Without Firebase in the build there is no token and
 * nothing is registered — the app still works, with no background push.
 */
class PushRegistrationTest {

    private lateinit var api: KurisuApiService
    private lateinit var prefs: PreferencesDataStore
    private var fcmToken: String? = "token-1"
    private var registered: String? = null
    private val tokens = object : FcmTokenSource {
        override suspend fun token(): String? = fcmToken
    }

    @Before
    fun setUp() {
        api = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        coEvery { prefs.getRegisteredPushToken() } answers { registered }
        coEvery { prefs.setRegisteredPushToken(any()) } answers { registered = firstArg() }
    }

    @Test
    fun `registers this app's token with the server`() = runTest {
        PushRegistration(api, prefs, tokens).register()
        coVerify { api.registerNotificationDevice(DeviceRegistration(platform = "android", fcmToken = "token-1")) }
        assertThat(registered).isEqualTo("token-1")
    }

    @Test
    fun `without Firebase there is nothing to register`() = runTest {
        fcmToken = null
        PushRegistration(api, prefs, tokens).register()
        coVerify(exactly = 0) { api.registerNotificationDevice(any()) }
    }

    @Test
    fun `unregistering takes the registered token away`() = runTest {
        registered = "token-1"
        PushRegistration(api, prefs, tokens).unregister()
        coVerify { api.deleteNotificationDevice("token-1") }
        assertThat(registered).isNull()
    }

    @Test
    fun `a new token replaces the registered one`() = runTest {
        registered = "token-1"
        PushRegistration(api, prefs, tokens).onNewToken("token-2")
        coVerify { api.registerNotificationDevice(DeviceRegistration(platform = "android", fcmToken = "token-2")) }
        coVerify { api.deleteNotificationDevice("token-1") }
        assertThat(registered).isEqualTo("token-2")
    }

    @Test
    fun `a new token while not registered stays unregistered`() = runTest {
        PushRegistration(api, prefs, tokens).onNewToken("token-2")
        coVerify(exactly = 0) { api.registerNotificationDevice(any()) }
    }

    @Test
    fun `a server that refuses does not break the app`() = runTest {
        coEvery { api.registerNotificationDevice(any()) } throws RuntimeException("offline")
        PushRegistration(api, prefs, tokens).register()
        assertThat(registered).isNull()
    }
}
