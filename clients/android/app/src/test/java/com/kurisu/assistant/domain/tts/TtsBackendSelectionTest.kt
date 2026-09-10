package com.kurisu.assistant.domain.tts

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * With no TTS model chosen, the request names none and the server's default
 * answers. The client used to invent `gpt-sovits`, which needs a reference
 * clip and is not normally running, so a fresh install could not speak (#200).
 */
class TtsBackendSelectionTest {

    @Test
    fun `nothing chosen means no provider on the request`() {
        assertThat(resolveTtsBackend(null)).isNull()
        assertThat(resolveTtsBackend("")).isNull()
        assertThat(resolveTtsBackend("  ")).isNull()
    }

    @Test
    fun `a chosen model is sent as typed`() {
        assertThat(resolveTtsBackend("vixtts")).isEqualTo("vixtts")
        assertThat(resolveTtsBackend(" vieneu:turbo ")).isEqualTo("vieneu:turbo")
    }
}
