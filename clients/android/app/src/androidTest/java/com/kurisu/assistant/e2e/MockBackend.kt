package com.kurisu.assistant.e2e

import com.kurisu.assistant.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * One standalone mock backend process, serving one scenario (#126, #310).
 *
 * A mock's scenario is fixed when it starts, so every scenario the suite uses
 * runs as its own process: `default` at [BuildConfig.MOCK_BACKEND_URL] and each
 * other one on that port plus its offset in [SCENARIO_PORT_OFFSETS]. CI starts
 * them all; locally, start the ones you run (`docs/testing.md`). The mocks keep
 * their state for the whole run, so a test only ever finds its own data by the
 * unique text it sent — never by position.
 */
class MockBackend(val scenario: String) {

    val url: String = urlFor(scenario)

    private val http = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    fun requireReachable() {
        try {
            val version = getJson("/version").jsonObject
            assertTrue(version.containsKey("wire_protocol"))
        } catch (e: Exception) {
            fail(
                "mock backend for the '$scenario' scenario not reachable at $url (${e.message}). Start it from " +
                    "clients/apps/desktop with: npm run mock:backend -- --host 0.0.0.0 --port ${URI(url).port}" +
                    (if (scenario == "default") "" else " --scenario $scenario"),
            )
        }
    }

    fun get(path: String): String = call(Request.Builder().url("$url$path").build())

    fun getJson(path: String): JsonElement = json.parseToJsonElement(get(path))

    fun patch(path: String, body: String): String = call(
        Request.Builder().url("$url$path").patch(body.toRequestBody("application/json".toMediaType())).build(),
    )

    /** Null when the mock answers 404: the thing is gone. */
    fun getOrNull(path: String): String? {
        val response = http.newCall(Request.Builder().url("$url$path").build()).execute()
        response.use {
            if (it.code == 404) return null
            if (!it.isSuccessful) throw IllegalStateException("GET $path -> ${it.code}")
            return it.body!!.string()
        }
    }

    private fun call(request: Request): String {
        val response = http.newCall(request).execute()
        response.use {
            if (!it.isSuccessful) throw IllegalStateException("${request.method} ${request.url.encodedPath} -> ${it.code}")
            return it.body!!.string()
        }
    }

    class StoredMessage(
        val role: String,
        val content: String,
        val personaId: String?,
        val name: String?,
        val thinking: String?,
    )

    fun conversationIds(): List<String> =
        getJson("/conversations").jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }

    fun conversation(id: String): JsonObject? = getOrNull("/conversations/$id")?.let { json.parseToJsonElement(it).jsonObject }

    /**
     * The conversation holding the user message `containing`, once `predicate`
     * holds for it — each is fetched in full because the list carries no
     * transcript. Newest first, since a test's conversation is usually the last.
     */
    fun waitForConversation(
        containing: String,
        timeoutMs: Long = UI_TIMEOUT_MS,
        onTimeout: () -> String = { "" },
        predicate: (JsonObject) -> Boolean,
    ): JsonObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        var seen: JsonObject? = null
        while (System.currentTimeMillis() < deadline) {
            for (id in conversationIds().reversed()) {
                val full = conversation(id) ?: continue
                if (full.messages().none { it.role == "user" && it.content == containing }) continue
                seen = full
                if (predicate(full)) return full
            }
            Thread.sleep(250)
        }
        throw AssertionError(
            "no '$scenario' mock conversation holding \"$containing\" reached the expected state; last seen: $seen. " +
                onTimeout(),
        )
    }

    companion object {
        const val UI_TIMEOUT_MS = 30_000L

        /**
         * Port offsets from the `default` mock, one process per scenario. CI's
         * workflow starts exactly these; keep the two in step.
         */
        val SCENARIO_PORT_OFFSETS = linkedMapOf(
            "default" to 0,
            "tool-call" to 1,
            "sub-agent" to 2,
            "handoff" to 3,
            "thinking" to 4,
            "slow" to 5,
            "no-model" to 6,
            "no-persona" to 7,
        )

        fun urlFor(scenario: String): String {
            val base = BuildConfig.MOCK_BACKEND_URL.trimEnd('/')
            if (base.isBlank()) fail("MOCK_BACKEND_URL is empty: run this suite on the dev flavour")
            val offset = SCENARIO_PORT_OFFSETS[scenario]
                ?: error("no port for scenario '$scenario'; add it to SCENARIO_PORT_OFFSETS and the CI workflow")
            val uri = URI(base)
            return URI(uri.scheme, null, uri.host, uri.port + offset, null, null, null).toString()
        }
    }
}

fun JsonObject.messages(): List<MockBackend.StoredMessage> =
    this["messages"]!!.jsonArray.map { m ->
        val o = m.jsonObject
        fun field(key: String) = o[key]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        MockBackend.StoredMessage(
            role = o["role"]!!.jsonPrimitive.content,
            content = o["content"]!!.jsonPrimitive.content,
            personaId = field("persona_id"),
            name = field("name"),
            thinking = field("thinking"),
        )
    }

/** The messages stored after the user message that reads exactly `text`. */
fun JsonObject.messagesAfter(text: String): List<MockBackend.StoredMessage> {
    val all = messages()
    val at = all.indexOfFirst { it.role == "user" && it.content == text }
    return if (at < 0) emptyList() else all.drop(at + 1)
}

fun JsonObject.string(key: String): String? = this[key]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
