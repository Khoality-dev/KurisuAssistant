package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.BuildConfig
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stamps every outgoing request with `X-Wire-Protocol: <int>` so the backend
 * can reject incompatible clients with HTTP 426.
 *
 * The startup check in [com.kurisu.assistant.MainActivity] is the primary
 * gate (cleaner UX); this interceptor is a defense-in-depth so we never
 * silently send wire-incompatible payloads.
 */
@Singleton
class WireProtocolInterceptor @Inject constructor() : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("X-Wire-Protocol", BuildConfig.WIRE_PROTOCOL.toString())
            .build()
        return chain.proceed(request)
    }
}
