package com.kurisuassistant.android.utils

import okhttp3.OkHttpClient
import java.time.Duration

object HttpClient {
    fun noTimeoutClient(): OkHttpClient = OkHttpClient.Builder()
        .callTimeout(Duration.ZERO)
        .connectTimeout(Duration.ZERO)
        .readTimeout(Duration.ZERO)
        .writeTimeout(Duration.ZERO)
        .build()
}
