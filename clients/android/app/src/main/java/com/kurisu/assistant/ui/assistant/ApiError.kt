package com.kurisu.assistant.ui.assistant

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import retrofit2.HttpException

private val errorJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * The message the user should read when a call fails.
 *
 * Several of the backend's rules are only expressible as a 4xx, and their text
 * is the whole explanation: "This is your only persona. Create another one
 * before deleting it.", "This is your default persona. Make another one the
 * default first.", "A disabled persona cannot be the default. Enable it first."
 * Retrofit turns those into an `HttpException` whose `message` is the useless
 * "HTTP 400 Bad Request", so without unwrapping `detail` the guards look like a
 * switch that silently refuses to move.
 */
fun apiErrorMessage(t: Throwable, fallback: String): String {
    val detail = (t as? HttpException)?.let { http ->
        // errorBody() is a one-shot stream; read it once and tolerate anything.
        val body = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
        body?.takeIf { it.isNotBlank() }?.let { raw ->
            runCatching {
                val obj = errorJson.parseToJsonElement(raw) as? JsonObject
                // FastAPI validation errors put a LIST under `detail`; only the
                // plain-string form is a sentence worth showing.
                (obj?.get("detail") as? JsonPrimitive)?.takeIf { it.isString }?.content
            }.getOrNull()
        }
    }
    return detail?.takeIf { it.isNotBlank() }
        ?: t.message?.takeIf { it.isNotBlank() }
        ?: fallback
}
