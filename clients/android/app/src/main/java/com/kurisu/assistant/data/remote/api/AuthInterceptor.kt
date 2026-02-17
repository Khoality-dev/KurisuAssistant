package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.data.local.EncryptedPreferences
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthInterceptor @Inject constructor(
    private val encryptedPreferences: EncryptedPreferences,
) : Interceptor {

    @Volatile
    private var tokenOverride: String? = null

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
        return chain.proceed(request)
    }
}
