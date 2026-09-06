package com.kurisu.assistant.data.remote.websocket

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import java.io.File

/**
 * This client's protocol constants must match the backend's (#93).
 *
 * The event names and the wire-protocol integer were retyped by hand from
 * `backend/kurisuassistant/websocket/events.py` and `version.py`, and nothing
 * checked that the copies agreed. `protocol/events.json` is generated from the
 * backend; this reads it and fails here, in this module's own CI job, when
 * Android drifts.
 */
class ProtocolEventsTest {

    private val manifest: JsonObject by lazy {
        // Walk up to the repository root, so this survives being run from the
        // module directory, the repo root, or a worktree.
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        repeat(8) {
            val candidate = File(dir, "protocol/events.json")
            if (candidate.isFile) return@lazy Json.parseToJsonElement(candidate.readText()).jsonObject
            dir = dir?.parentFile
        }
        error("protocol/events.json not found — the backend generates it")
    }

    private fun named(direction: String, transport: String = "json"): Set<String> =
        manifest["events"]!!.jsonObject.entries
            .filter {
                val entry = it.value.jsonObject
                entry["direction"]!!.jsonPrimitive.content == direction &&
                    entry["transport"]!!.jsonPrimitive.content == transport
            }
            .map { it.key }
            .toSet()

    @Test
    fun `the client-to-server names match the backend's`() {
        // The registry, not a claim that this client sends all of them — it does
        // not use client_tools_register, which is the desktop's host-tool path.
        // Equality is still what catches a rename or an addition.
        assertThat(ProtocolEvents.CLIENT_TO_SERVER).isEqualTo(named("client_to_server"))
    }

    @Test
    fun `the events this client handles are the ones the backend sends`() {
        assertThat(ProtocolEvents.SERVER_TO_CLIENT).isEqualTo(named("server_to_client"))
    }

    @Test
    fun `every event the backend sends is parsed rather than dropped`() {
        // The drift this issue was filed about was a dropped event, so assert
        // the parser itself, not only the constant list.
        for (type in named("server_to_client")) {
            val payload = """{"type":"$type","event_id":"e","timestamp":"t"}"""
            assertThat(parseServerEvent(payload)).isNotNull()
        }
    }

    @Test
    fun `the wire protocol matches the backend`() {
        assertThat(BuildConfig.WIRE_PROTOCOL)
            .isEqualTo(manifest["wire_protocol"]!!.jsonPrimitive.int)
    }

    @Test
    fun `a binary message is not treated as a JSON event`() {
        // A webcam frame has its own envelope (#111); it must not appear in
        // either list, or someone will send it as JSON again.
        val binary = named("client_to_server", transport = "binary")
        assertThat(binary).contains("vision_frame")
        assertThat(ProtocolEvents.CLIENT_TO_SERVER).containsNoneIn(binary)
        assertThat(ProtocolEvents.SERVER_TO_CLIENT).containsNoneIn(binary)
    }
}
