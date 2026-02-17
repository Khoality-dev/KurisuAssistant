package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.UserProfile
import com.kurisu.assistant.data.remote.api.AuthInterceptor
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val api: KurisuApiService,
    private val encryptedPrefs: EncryptedPreferences,
    private val prefs: PreferencesDataStore,
    private val authInterceptor: AuthInterceptor,
    private val wsManager: WebSocketManager,
) {
    suspend fun login(username: String, password: String, rememberMe: Boolean): UserProfile {
        val response = api.login(
            username = username.toPlainBody(),
            password = password.toPlainBody(),
        )
        applyToken(response.accessToken, rememberMe)
        return api.getUserProfile()
    }

    suspend fun register(username: String, password: String, email: String?, rememberMe: Boolean): UserProfile {
        val response = api.register(
            username = username.toPlainBody(),
            password = password.toPlainBody(),
            email = email?.toPlainBody(),
        )
        applyToken(response.accessToken, rememberMe)
        return api.getUserProfile()
    }

    suspend fun logout() {
        authInterceptor.clearToken()
        encryptedPrefs.clearToken()
        prefs.setRememberMe(false)
        prefs.clearAllAgentConversations()
        wsManager.clearToken()
        wsManager.disconnect()
    }

    suspend fun initializeAuth(): UserProfile? {
        val token = encryptedPrefs.getToken()
        val rememberMe = prefs.getRememberMe()
        if (token != null && rememberMe) {
            return try {
                authInterceptor.setToken(token)
                wsManager.setToken(token)
                api.getUserProfile()
            } catch (_: Exception) {
                encryptedPrefs.clearToken()
                prefs.setRememberMe(false)
                authInterceptor.clearToken()
                null
            }
        }
        return null
    }

    suspend fun loadUserProfile(): UserProfile = api.getUserProfile()

    suspend fun updateUserProfile(profile: UserProfile): UserProfile =
        api.updateUserProfile(profile)

    private suspend fun applyToken(token: String, rememberMe: Boolean) {
        authInterceptor.setToken(token)
        wsManager.setToken(token)
        if (rememberMe) {
            encryptedPrefs.setToken(token)
            prefs.setRememberMe(true)
        } else {
            encryptedPrefs.clearToken()
            prefs.setRememberMe(false)
        }
    }

    private fun String.toPlainBody() =
        this.toRequestBody("text/plain".toMediaTypeOrNull())
}
