package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.push.PushRegistration
import com.kurisu.assistant.data.remote.api.AuthInterceptor
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import io.mockk.coVerifyOrder
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Signing out stops push to this phone (#353): the token is unregistered while
 * the session can still authenticate the request, or the server would keep
 * pushing the old account's notifications to whoever signs in next.
 */
class AuthRepositoryPushTest {

    @Test
    fun `signing out unregisters push before the session is cleared`() = runTest {
        val push = mockk<PushRegistration>(relaxed = true)
        val interceptor = mockk<AuthInterceptor>(relaxed = true)
        val repository = AuthRepository(
            api = mockk<KurisuApiService>(relaxed = true),
            encryptedPrefs = mockk<EncryptedPreferences>(relaxed = true),
            prefs = mockk<PreferencesDataStore>(relaxed = true),
            authInterceptor = interceptor,
            wsManager = mockk<WebSocketManager>(relaxed = true),
            pushRegistration = push,
        )
        repository.logout()
        coVerifyOrder {
            push.unregister()
            interceptor.clearToken()
        }
    }
}
