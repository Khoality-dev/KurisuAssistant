package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.ServerVersionInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stamps every outgoing request with `X-Wire-Protocol: <int>` so the backend
 * can reject incompatible clients with HTTP 426 — and turns that 426 into a
 * [ProtocolMismatchSignal], so a server that changed protocol *after* the
 * startup check lands on the update gate instead of a generic error (#150).
 *
 * The startup check in [com.kurisu.assistant.MainActivity] is the primary
 * gate (cleaner UX); this interceptor is the defense-in-depth for the session
 * that outlives it.
 */
@Singleton
class WireProtocolInterceptor @Inject constructor(
    private val signal: ProtocolMismatchSignal,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("X-Wire-Protocol", BuildConfig.WIRE_PROTOCOL.toString())
            .build()
        val response = chain.proceed(request)
        if (response.code == HTTP_UPGRADE_REQUIRED) {
            // peekBody leaves the body readable for whoever is downstream.
            val body = runCatching { response.peekBody(PEEK_LIMIT).string() }.getOrNull()
            signal.signal(parse426Body(body) ?: ProtocolMismatchSignal.unknown)
        }
        return response
    }

    companion object {
        const val HTTP_UPGRADE_REQUIRED = 426
        private const val PEEK_LIMIT = 4096L
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * The backend's 426 body:
         * `{"detail":"wire_protocol_mismatch","client_wire_protocol":n,
         *   "server_wire_protocol":n,"backend_version":"x"}`.
         * Null when the body is not that shape — a proxy's own 426, say.
         */
        fun parse426Body(body: String?): ServerVersionInfo? {
            if (body.isNullOrBlank()) return null
            return runCatching {
                val obj = json.parseToJsonElement(body).jsonObject
                val wire = obj["server_wire_protocol"]?.jsonPrimitive?.content?.toInt()
                    ?: return null
                val version = obj["backend_version"]?.jsonPrimitive?.content ?: "?"
                ServerVersionInfo(backendVersion = version, wireProtocol = wire)
            }.getOrNull()
        }
    }
}
