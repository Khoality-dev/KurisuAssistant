package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import org.junit.Test

/**
 * The emotion channel's two carriers decode with and without the new fields (#243).
 *
 * Both are optional on the wire: a backend without the channel, a pose-graph
 * persona, and every user or tool message send nothing, and the same models
 * must read those as before. `at` is in UTF-16 code units — Kotlin's
 * `String.length` — so an emoji before a tag counts two, as it does in the
 * text the app accumulates.
 */
class EmotionCueTest {

    // Same configuration as WebSocketManager and NetworkModule.
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    @Test
    fun `a stream chunk carries the feeling and where it starts`() {
        val chunk = json.decodeFromString(
            StreamChunkEvent.serializer(),
            """{"type":"stream_chunk","content":"Bye.","role":"assistant","conversation_id":7,"emotion":"sad","emotion_at":4}""",
        )
        assertThat(chunk.emotion).isEqualTo("sad")
        assertThat(chunk.emotionAt).isEqualTo(4)
    }

    @Test
    fun `a stream chunk without the fields decodes as before`() {
        val chunk = json.decodeFromString(
            StreamChunkEvent.serializer(),
            """{"type":"stream_chunk","content":"Hi.","role":"assistant","conversation_id":7}""",
        )
        assertThat(chunk.emotion).isNull()
        assertThat(chunk.emotionAt).isNull()
    }

    @Test
    fun `explicit nulls decode as absent`() {
        val chunk = json.decodeFromString(
            StreamChunkEvent.serializer(),
            """{"type":"stream_chunk","content":"","role":"tool","conversation_id":7,"emotion":null,"emotion_at":null}""",
        )
        assertThat(chunk.emotion).isNull()
    }

    @Test
    fun `a history message carries its cues in order`() {
        val message = json.decodeFromString(
            Message.serializer(),
            """{"id":3,"role":"assistant","content":"Hello there. Goodbye.","emotion_cues":[{"emotion":"happy","at":0},{"emotion":"sad","at":13}]}""",
        )
        assertThat(message.emotionCues).containsExactly(EmotionCue("happy", 0), EmotionCue("sad", 13)).inOrder()
    }

    @Test
    fun `a message without cues has none`() {
        val message = json.decodeFromString(Message.serializer(), """{"id":3,"role":"user","content":"hi"}""")
        assertThat(message.emotionCues).isNull()
    }

    @Test
    fun `the offset unit is String length`() {
        // The backend counts "😀 " as 3 (UTF-16), which is what String.length says here.
        assertThat("😀 ".length).isEqualTo(3)
        assertThat("😀 x".substring(3)).isEqualTo("x")
    }
}
