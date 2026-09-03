package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.data.local.PreferencesDataStore
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class DynamicBaseUrlInterceptor @Inject constructor(
    private val preferencesDataStore: PreferencesDataStore,
) : Interceptor {

    @Volatile
    private var cachedBaseUrl: String? = null

    fun setCachedBaseUrl(url: String) {
        cachedBaseUrl = url
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val baseUrl = cachedBaseUrl ?: runBlocking { preferencesDataStore.getBackendUrl() }
        cachedBaseUrl = baseUrl

        val originalRequest = chain.request()
        val originalUrl = originalRequest.url

        // Replace the placeholder host with the real base URL
        val newBase = baseUrl.trimEnd('/').toHttpUrlOrNull()
        if (newBase != null && originalUrl.host == "placeholder") {
            val newUrl = originalUrl.newBuilder()
                .scheme(newBase.scheme)
                .host(newBase.host)
                .port(newBase.port)
                .encodedPath(newBase.encodedPath.trimEnd('/') + originalUrl.encodedPath)
                .build()

            val newRequest = originalRequest.newBuilder().url(newUrl).build()
            return chain.proceed(newRequest)
        }

        return chain.proceed(originalRequest)
    }
}
