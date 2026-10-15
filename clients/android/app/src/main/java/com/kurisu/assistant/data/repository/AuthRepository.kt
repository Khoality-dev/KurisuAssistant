package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.push.PushRegistration
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.api.AuthInterceptor
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import com.kurisu.assistant.domain.time.deviceTimezone
import com.kurisu.assistant.domain.time.fillTimezoneIfUnset
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val api: KurisuApiService,
    private val encryptedPrefs: EncryptedPreferences,
    private val prefs: PreferencesDataStore,
    private val authInterceptor: AuthInterceptor,
    private val wsManager: WebSocketManager,
    private val pushRegistration: PushRegistration,
) {
    suspend fun login(username: String, password: String, rememberMe: Boolean): UserProfile {
        val response = api.login(
            username = username.toPlainBody(),
            password = password.toPlainBody(),
        )
        applyToken(response.accessToken, response.refreshToken, rememberMe)
        return withAccountTimezone(api.getUserProfile())
    }

    suspend fun register(username: String, password: String, email: String?, rememberMe: Boolean): UserProfile {
        val response = api.register(
            username = username.toPlainBody(),
            password = password.toPlainBody(),
            email = email?.toPlainBody(),
        )
        applyToken(response.accessToken, response.refreshToken, rememberMe)
        return withAccountTimezone(api.getUserProfile())
    }

    suspend fun logout() {
        // While the session can still authenticate it (#353): otherwise the
        // server keeps pushing this account's notifications to this phone.
        pushRegistration.unregister()
        authInterceptor.clearToken()
        encryptedPrefs.clearToken()
        encryptedPrefs.clearRefreshToken()
        prefs.setRememberMe(false)
        wsManager.clearToken()
        wsManager.disconnect()
    }

    suspend fun initializeAuth(): UserProfile? {
        val token = encryptedPrefs.getToken()
        val rememberMe = prefs.getRememberMe()
        if (token != null && rememberMe) {
            authInterceptor.setToken(token)
            wsManager.setToken(token)
            return try {
                withAccountTimezone(api.getUserProfile())
            } catch (_: Exception) {
                // Access token may be expired — try refresh
                val refreshToken = encryptedPrefs.getRefreshToken()
                if (refreshToken != null) {
                    try {
                        val response = api.refreshToken(mapOf("refresh_token" to refreshToken))
                        applyToken(response.accessToken, response.refreshToken, rememberMe)
                        withAccountTimezone(api.getUserProfile())
                    } catch (_: Exception) {
                        clearAllTokens()
                        null
                    }
                } else {
                    clearAllTokens()
                    null
                }
            }
        }
        return null
    }

    suspend fun loadUserProfile(): UserProfile = api.getUserProfile()

    suspend fun updateUserProfile(profile: UserProfile): UserProfile =
        api.updateUserProfile(profile)

    /** Set (or, with a blank [zone], clear) the account's time zone. A 422 names a bad one. */
    suspend fun setTimezone(zone: String) {
        api.patchUserProfile(buildJsonObject { put("timezone", zone.trim()) })
    }

    /** An empty account time zone is filled from this phone, once, silently (#352). */
    private suspend fun withAccountTimezone(user: UserProfile): UserProfile =
        fillTimezoneIfUnset(user, deviceTimezone()) { zone ->
            api.patchUserProfile(buildJsonObject { put("timezone", zone) })
        }

    private suspend fun applyToken(accessToken: String, refreshToken: String?, rememberMe: Boolean) {
        authInterceptor.setToken(accessToken)
        wsManager.setToken(accessToken)
        if (rememberMe) {
            encryptedPrefs.setToken(accessToken)
            refreshToken?.let { encryptedPrefs.setRefreshToken(it) }
            prefs.setRememberMe(true)
        } else {
            encryptedPrefs.clearToken()
            encryptedPrefs.clearRefreshToken()
            prefs.setRememberMe(false)
        }
    }

    private fun clearAllTokens() {
        encryptedPrefs.clearToken()
        encryptedPrefs.clearRefreshToken()
        authInterceptor.clearToken()
    }

    private fun String.toPlainBody() =
        this.toRequestBody("text/plain".toMediaTypeOrNull())
}
