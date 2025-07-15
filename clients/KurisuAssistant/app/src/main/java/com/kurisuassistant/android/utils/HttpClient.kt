package com.kurisuassistant.android.utils

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import java.time.Duration

import com.kurisuassistant.android.Auth

object HttpClient {
    val noTimeout: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .callTimeout(Duration.ZERO)
            .connectTimeout(Duration.ZERO)
            .readTimeout(Duration.ZERO)
            .writeTimeout(Duration.ZERO)
            .addInterceptor { chain ->
                val request = chain.request().newBuilder()
                Auth.token?.let { request.addHeader("Authorization", "Bearer $it") }
                chain.proceed(request.build())
            }
            .build()
    }

    fun get(url: String, token: String): String {
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $token")
            .build()

        noTimeout.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw Exception("HTTP ${response.code}: ${response.message}")
            }
            return response.body?.string() ?: ""
        }
    }

    fun post(url: String, body: RequestBody, token: String? = null): Response {
        val requestBuilder = Request.Builder()
            .url(url)
            .post(body)
        
        token?.let { requestBuilder.addHeader("Authorization", "Bearer $it") }
        
        return noTimeout.newCall(requestBuilder.build()).execute()
    }

    fun getResponse(url: String, token: String? = null): Response {
        val requestBuilder = Request.Builder().url(url)
        token?.let { requestBuilder.addHeader("Authorization", "Bearer $it") }
        
        return noTimeout.newCall(requestBuilder.build()).execute()
    }

    fun put(url: String, body: RequestBody, token: String? = null): Response {
        val requestBuilder = Request.Builder()
            .url(url)
            .put(body)
        
        token?.let { requestBuilder.addHeader("Authorization", "Bearer $it") }
        
        return noTimeout.newCall(requestBuilder.build()).execute()
    }
}
