package com.kurisu.assistant.data.remote.api

import com.kurisu.assistant.data.model.ServerVersionInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A wire-protocol mismatch seen on a *live* connection — an HTTP 426 from
 * [WireProtocolInterceptor] or a 4426 close from the WebSocket — rather than
 * by the startup `GET /version` check. `MainActivity` collects it and raises
 * the same update gate the startup check does (#150); "Change server" clears it.
 */
@Singleton
class ProtocolMismatchSignal @Inject constructor() {
    private val _mismatch = MutableStateFlow<ServerVersionInfo?>(null)
    val mismatch: StateFlow<ServerVersionInfo?> = _mismatch

    fun signal(info: ServerVersionInfo) {
        _mismatch.value = info
    }

    fun clear() {
        _mismatch.value = null
    }

    companion object {
        /** The server refused the protocol without saying which one it speaks. */
        const val UNKNOWN_WIRE_PROTOCOL = -1

        val unknown = ServerVersionInfo(backendVersion = "?", wireProtocol = UNKNOWN_WIRE_PROTOCOL)
    }
}
