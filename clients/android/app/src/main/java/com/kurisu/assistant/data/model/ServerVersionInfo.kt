package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Response shape of `GET /version` on the backend. */
@Serializable
data class ServerVersionInfo(
    @SerialName("backend_version") val backendVersion: String,
    @SerialName("wire_protocol") val wireProtocol: Int,
)
