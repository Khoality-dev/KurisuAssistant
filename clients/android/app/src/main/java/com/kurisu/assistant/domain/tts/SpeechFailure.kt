package com.kurisu.assistant.domain.tts

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.HttpException
import java.io.IOException

/**
 * One sentence a person can act on, for a speech request that failed.
 *
 * The API answers speech failures with a JSON `detail` written for the user
 * ("The speech service is unavailable."); that is what to show when it is
 * there. Anything else is reduced to the kind of failure, never a stack trace.
 */
fun describeSpeechFailure(what: String, error: Throwable): String {
    val reason = when (error) {
        is HttpException -> {
            val body = runCatching { error.response()?.errorBody()?.string() }.getOrNull()
            apiDetail(body) ?: "the server answered ${error.code()}"
        }
        is IOException -> "the server could not be reached"
        else -> error.message?.takeIf { it.isNotBlank() } ?: "something went wrong"
    }
    return "$what failed: ${reason.trimEnd('.')}."
}

private fun apiDetail(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return runCatching {
        Json.parseToJsonElement(body).jsonObject["detail"]?.jsonPrimitive?.content
    }.getOrNull()?.takeIf { it.isNotBlank() }
}
