package com.kurisu.assistant.domain.character.vrm

import com.google.common.truth.Truth.assertThat
import com.google.common.truth.Truth.assertWithMessage
import com.kurisu.assistant.domain.tts.SpeechCue
import com.kurisu.assistant.domain.tts.SpeechSegment
import com.kurisu.assistant.domain.tts.SpeechSync
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import java.io.File

/**
 * What Android pushes to the character page is the page's own contract: one
 * golden fixture per message under `clients/packages/vrm/src/page/fixtures/`,
 * which the page's `host.test.ts` parses too (#245). A field renamed on either
 * side turns one of these red instead of a face that silently stops moving.
 */
class BridgeMessagesTest {

    private val fixtures: File by lazy {
        // Walk up to the repository root, as ProtocolEventsTest does.
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        repeat(8) {
            val candidate = File(dir, "clients/packages/vrm/src/page/fixtures")
            if (candidate.isDirectory) return@lazy candidate
            dir = dir?.parentFile
        }
        error("the character page's fixtures were not found")
    }

    private fun fixture(name: String): JsonElement =
        Json.parseToJsonElement(File(fixtures, "$name.json").readText())

    /** JSON equality where 2400 and 2400.0 are the same number, as they are to the page. */
    private fun assertSameJson(actual: JsonElement, expected: JsonElement, path: String = "$") {
        when (expected) {
            is JsonObject -> {
                assertThat(actual).isInstanceOf(JsonObject::class.java)
                actual as JsonObject
                assertWithMessage(path).that(actual.keys).isEqualTo(expected.keys)
                expected.forEach { (k, v) -> assertSameJson(actual.getValue(k), v, "$path.$k") }
            }
            is JsonArray -> {
                assertThat(actual).isInstanceOf(JsonArray::class.java)
                actual as JsonArray
                assertWithMessage(path).that(actual.size).isEqualTo(expected.size)
                expected.forEachIndexed { i, v -> assertSameJson(actual[i], v, "$path[$i]") }
            }
            is JsonNull -> assertWithMessage(path).that(actual).isEqualTo(JsonNull)
            is JsonPrimitive -> {
                actual as JsonPrimitive
                if (!expected.isString && expected.doubleOrNull != null) {
                    assertWithMessage(path).that(actual.isString).isFalse()
                    assertWithMessage(path).that(actual.doubleOrNull!!).isWithin(1e-4).of(expected.doubleOrNull!!)
                } else {
                    assertWithMessage(path).that(actual).isEqualTo(expected)
                }
            }
        }
    }

    @Test
    fun `config carries the persona's character verbatim`() {
        val expected = fixture("config")
        val character = expected.jsonObject.getValue("character").jsonObject
        assertSameJson(BridgeMessages.config(character, "Kurisu"), expected)
    }

    @Test
    fun `a spoken sentence is one speech message with its curve and cues`() {
        val segment = SpeechSegment(
            text = "Hello there. I was hoping you would come back.",
            startedAt = 1758326400000,
            durationMs = 2400,
            windowMs = 33.31,
            curve = floatArrayOf(0f, 0.1f, 0.4f, 0.7f, 0.5f, 0.2f, 0.6f, 0.8f, 0.3f, 0f),
            cues = listOf(SpeechCue("happy", 1100)),
        )
        assertSameJson(BridgeMessages.speech(segment), fixture("speech"))
        assertSameJson(BridgeMessages.speech(null), fixture("speech-null"))
    }

    @Test
    fun `the rest of the feed matches the page's fixtures`() {
        assertSameJson(BridgeMessages.speechSync(SpeechSync(positionMs = 812, at = 1758326400812)), fixture("speech-sync"))
        assertSameJson(BridgeMessages.feed(isThinking = true), fixture("feed"))
        assertSameJson(BridgeMessages.gestures(listOf("wave", "open_palm"), seq = 17), fixture("gestures"))
        assertSameJson(BridgeMessages.faces(listOf("Khoa", "Unknown")), fixture("faces"))
        assertSameJson(BridgeMessages.subtitle("Hello there.", isUser = false, durationMs = 1800), fixture("subtitle"))
        assertSameJson(BridgeMessages.resting("relaxed")!!, fixture("resting"))
    }

    @Test
    fun `every message type the page accepts has an encoder`() {
        // host.ts HOST_MESSAGE_TYPES; a type added there and not here is a feed Android never sends.
        assertThat(BridgeMessages.TYPES).containsExactly(
            "config", "speech", "speech-sync", "feed", "gestures", "faces", "subtitle", "resting",
        )
    }

    @Test
    fun `a feeling the page does not know is never sent`() {
        // The page rejects the whole message for one unknown emotion, so a stray
        // label would cost the sentence its mouth movement as well.
        val segment = SpeechSegment("Hi.", 1, 500, 33.3, null, listOf(SpeechCue("smug", 10), SpeechCue("sad", 20)))
        val cues = BridgeMessages.speech(segment).jsonObject.getValue("segment").jsonObject.getValue("cues") as JsonArray
        assertThat(cues.map { it.jsonObject.getValue("emotion") }).containsExactly(JsonPrimitive("sad"))
        assertThat(BridgeMessages.resting("smug")).isNull()
    }
}
