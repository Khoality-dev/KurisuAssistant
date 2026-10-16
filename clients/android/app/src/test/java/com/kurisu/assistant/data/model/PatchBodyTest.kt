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
    fun `the permission mode goes on the wire spelled as the server spells it`() {
        // #360: one mode for the account; "ask", "read_only" or "full".
        val obj = encode(AssistantUpdate(permissionMode = PermissionMode.READ_ONLY))

        assertThat(obj.keys).containsExactly("permission_mode")
        assertThat(obj["permission_mode"]!!.jsonPrimitive.content).isEqualTo("read_only")
    }

    @Test
    fun `an assistant patch never carries a tool list`() {
        // available_tools is gone (#360): the server refuses it with a 422.
        val names = AssistantUpdate::class.java.declaredFields.map { it.name }
        assertThat(names).doesNotContain("availableTools")
    }

    @Test
    fun `the assistant reads its permission mode, and an old body without one is Always ask`() {
        val full = json.decodeFromString(Assistant.serializer(), """{"id":1,"permission_mode":"full"}""")
        assertThat(full.permissionMode).isEqualTo(PermissionMode.FULL)
        val bare = json.decodeFromString(Assistant.serializer(), """{"id":1}""")
        assertThat(bare.permissionMode).isEqualTo(PermissionMode.ASK)
    }

    @Test
    fun `a tool says whether it only looks, and saying nothing is a change`() {
        val read = json.decodeFromString(Tool.serializer(), """{"type":"function","function":{"name":"drive_read","description":""},"read_only":true}""")
        val unsaid = json.decodeFromString(Tool.serializer(), """{"type":"function","function":{"name":"x","description":""}}""")
        assertThat(read.readOnly).isTrue()
        assertThat(unsaid.readOnly).isFalse()
    }

    @Test
    fun `the tools response names the server's own tools server_tools`() {
        val body = json.decodeFromString(
            ToolsResponse.serializer(),
            """{"server_tools":[{"type":"function","function":{"name":"notify_user","description":""},"read_only":true}],"mcp_tools":[]}""",
        )
        assertThat(body.serverTools.map { it.function.name }).containsExactly("notify_user")
    }

    @Test
    fun `a persona patch ships only the fields it set`() {
        val body = PersonaUpdate(name = "Kurisu")
        val obj = json.parseToJsonElement(
            json.encodeToString(PersonaUpdate.serializer(), body)
        ) as JsonObject

        assertThat(obj.keys).containsExactly("name")
    }
}
