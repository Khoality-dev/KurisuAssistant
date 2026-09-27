package com.kurisu.assistant.data.model

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.di.NetworkModule
import org.junit.Test

/**
 * `GET /tts/voices` as the backend answers it (#214): one object per preset
 * voice — the engine's `{id, name}` and the model that offers it. The app
 * typed it as a list of strings, so the response failed to decode and the
 * persona editor fell back to "No voices available" whatever the engines had.
 */
class VoicesResponseTest {

    private val json = NetworkModule.provideJson()

    private val backendAnswer = """
        {"voices": [
          {"id": "kurisu_ja_01", "name": "Kurisu (Japanese)", "model": "gpt-sovits"},
          {"id": "coach", "name": "Coach", "model": "vixtts"}
        ]}
    """.trimIndent()

    @Test
    fun `the backend's voice list decodes, each voice with its id, name and model`() {
        val voices = json.decodeFromString(VoicesResponse.serializer(), backendAnswer).voices

        assertThat(voices.map { it.id }).containsExactly("kurisu_ja_01", "coach").inOrder()
        assertThat(voices.map { it.label }).containsExactly("Kurisu (Japanese)", "Coach").inOrder()
        assertThat(voices.map { it.model }).containsExactly("gpt-sovits", "vixtts").inOrder()
    }

    @Test
    fun `a stored voice reads as its preset's name, and as itself when no engine lists it`() {
        val voices = json.decodeFromString(VoicesResponse.serializer(), backendAnswer).voices

        assertThat(voices.labelOf("kurisu_ja_01")).isEqualTo("Kurisu (Japanese)")
        // A clip in the server's voice storage, or a preset whose engine is down.
        assertThat(voices.labelOf("kurisu_neutral")).isEqualTo("kurisu_neutral")
    }

    @Test
    fun `a voice an engine left unnamed reads as its id`() {
        val voices = json.decodeFromString(
            VoicesResponse.serializer(),
            """{"voices": [{"id": "v1", "model": "vixtts"}]}""",
        ).voices

        assertThat(voices.single().label).isEqualTo("v1")
    }
}
