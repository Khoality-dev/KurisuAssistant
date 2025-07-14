package com.kurisuassistant.android.utils

import okhttp3.OkHttpClient
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
}
