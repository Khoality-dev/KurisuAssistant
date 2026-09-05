package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * The PATCH bodies must stay PARTIAL on the wire.
 *
 * Every one of these routes reads the request through Pydantic's
 * `model_fields_set`: an absent key is left alone, while an explicit `null`
 * either CLEARS the column or is rejected outright. Retrofit serializes these
 * with the app's shared `Json`, which sets `encodeDefaults = true` — so without
 * `@EncodeDefault(NEVER)` on every field, a one-field patch would ship every
 * other field as null and either blank the row or 400 the request
 * (`'provider_type' cannot be null.`).
 *
 * This test pins that behaviour against the real configuration.
 */
class PatchBodyTest {

    // Same configuration as NetworkModule.provideJson().
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private fun encode(body: AssistantUpdate) =
        json.parseToJsonElement(json.encodeToString(AssistantUpdate.serializer(), body)) as JsonObject

    @Test
    fun `an assistant patch ships only the fields it set`() {
        val obj = encode(AssistantUpdate(modelName = "qwen3:8b"))

        assertThat(obj.keys).containsExactly("model_name")
        assertThat(obj["model_name"]!!.jsonPrimitive.content).isEqualTo("qwen3:8b")
    }

    @Test
    fun `a non-nullable assistant column is never sent as null`() {
        // provider_type, think, use_deferred_tools and memory_enabled are all
        // rejected as null by the backend; omitting them is the only safe default.
        val obj = encode(AssistantUpdate(triggerWord = "kurisu"))

        assertThat(obj.keys).doesNotContain("provider_type")
        assertThat(obj.keys).doesNotContain("think")
        assertThat(obj.keys).doesNotContain("use_deferred_tools")
        assertThat(obj.keys).doesNotContain("memory_enabled")
    }

    @Test
    fun `an empty tool list is sent, because it does not mean the same as absent`() {
        // null available_tools means "every tool" server-side; an empty list means
        // "no tools". The empty list must therefore survive serialization.
        val obj = encode(AssistantUpdate(availableTools = emptyList()))

        assertThat(obj.keys).containsExactly("available_tools")
    }

    @Test
    fun `a persona patch ships only the fields it set`() {
        val body = PersonaUpdate(name = "Kurisu")
        val obj = json.parseToJsonElement(
            json.encodeToString(PersonaUpdate.serializer(), body)
        ) as JsonObject

        assertThat(obj.keys).containsExactly("name")
    }

    @Test
    fun `a sub-agent patch ships only the fields it set`() {
        val body = SubAgentUpdate(think = true)
        val obj = json.parseToJsonElement(
            json.encodeToString(SubAgentUpdate.serializer(), body)
        ) as JsonObject

        assertThat(obj.keys).containsExactly("think")
    }
}
