package com.kurisu.assistant.data.repository

import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.ServerVersionInfo
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

sealed class VersionCheck {
    object Compatible : VersionCheck()
    data class Mismatch(val info: ServerVersionInfo) : VersionCheck()
    data class Unreachable(val message: String) : VersionCheck()
}

@Singleton
class VersionRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /**
     * Hits `GET /version` and compares the server's wire-protocol integer
     * against the client's compiled-in [BuildConfig.WIRE_PROTOCOL]. The
     * caller is expected to gate UI on this — Mismatch should block usage.
     */
    suspend fun check(): VersionCheck = try {
        val info = api.getServerVersion()
        if (info.wireProtocol == BuildConfig.WIRE_PROTOCOL) {
            VersionCheck.Compatible
        } else {
            VersionCheck.Mismatch(info)
        }
    } catch (e: Exception) {
        VersionCheck.Unreachable(e.message ?: e::class.java.simpleName)
    }

    suspend fun fetchServerVersion(): ServerVersionInfo? = try {
        api.getServerVersion()
    } catch (_: Exception) {
        null
    }
}
