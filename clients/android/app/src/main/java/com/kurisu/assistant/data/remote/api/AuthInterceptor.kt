package com.kurisu.assistant.data.remote.api

import android.util.Log
import com.kurisu.assistant.data.local.EncryptedPreferences
import com.kurisu.assistant.data.local.PreferencesDataStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthInterceptor @Inject constructor(
    private val encryptedPreferences: EncryptedPreferences,
    private val preferencesDataStore: PreferencesDataStore,
) : Interceptor {

    companion object {
        private const val TAG = "AuthInterceptor"
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var tokenOverride: String? = null

    // Guard to coalesce concurrent refresh attempts
    private val refreshLock = Any()
    @Volatile
    private var isRefreshing = false

    fun setToken(token: String) {
        tokenOverride = token
    }

    fun clearToken() {
        tokenOverride = null
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokenOverride ?: encryptedPreferences.getToken()
        val request = if (token != null) {
            chain.request().newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        } else {
            chain.request()
        }

        val response = chain.proceed(request)

        // Auto-refresh on 401 (skip for auth endpoints to avoid loops)
        if (response.code == 401 && !isAuthEndpoint(request)) {
            response.close()
            val newToken = tryRefreshToken(token)
            if (newToken != null) {
                val retryRequest = request.newBuilder()
                    .header("Authorization", "Bearer $newToken")
                    .build()
                return chain.proceed(retryRequest)
            }
            // Refresh failed — return a 401 response
            return chain.proceed(request)
        }

        return response
    }

    private fun isAuthEndpoint(request: Request): Boolean {
        val path = request.url.encodedPath
        return path.endsWith("/login") ||
            path.endsWith("/register") ||
            path.endsWith("/auth/refresh")
    }

    /**
     * Attempt to refresh the access token using the stored refresh token.
     * Uses synchronized to coalesce concurrent refresh attempts.
     * Makes a raw OkHttp call to avoid going through the interceptor chain.
     */
    private fun tryRefreshToken(failedToken: String?): String? {
        synchronized(refreshLock) {
            // If another thread already refreshed while we waited, use the new token
            val currentToken = tokenOverride ?: encryptedPreferences.getToken()
            if (currentToken != null && currentToken != failedToken) {
                return currentToken
            }

            if (isRefreshing) return null
            isRefreshing = true

            try {
                val refreshToken = encryptedPreferences.getRefreshToken() ?: return null
                val baseUrl = runBlocking { preferencesDataStore.getBackendUrl() }

                val body = """{"refresh_token":"$refreshToken"}"""
                    .toRequestBody("application/json".toMediaType())

                val refreshRequest = Request.Builder()
                    .url("${baseUrl.trimEnd('/')}/auth/refresh")
                    .post(body)
                    .build()

                // Use a simple OkHttp client without interceptors to avoid recursion
                val simpleClient = okhttp3.OkHttpClient.Builder()
                    .build()

                val refreshResponse = simpleClient.newCall(refreshRequest).execute()
                if (refreshResponse.isSuccessful) {
                    val responseBody = refreshResponse.body?.string() ?: return null
                    val jsonElement = json.parseToJsonElement(responseBody)
                    val newAccessToken = jsonElement.jsonObject["access_token"]?.jsonPrimitive?.content
                        ?: return null

                    // Store and apply the new token
                    tokenOverride = newAccessToken
                    encryptedPreferences.setToken(newAccessToken)
                    Log.d(TAG, "Token refreshed successfully")
                    return newAccessToken
                } else {
                    Log.e(TAG, "Token refresh failed: ${refreshResponse.code}")
                    return null
                }
            } catch (e: Exception) {
                Log.e(TAG, "Token refresh error: ${e.message}")
                return null
            } finally {
                isRefreshing = false
            }
        }
    }
}
