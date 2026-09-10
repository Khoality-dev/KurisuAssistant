package com.kurisu.assistant.domain.audio

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.AsrLanguageModelEntry
import org.junit.Test

/**
 * The ASR model a clip is transcribed with comes from the Speech settings
 * (#200). Before this the settings were stored and shown and never sent.
 */
class AsrModelSelectionTest {

    private val map = listOf(
        AsrLanguageModelEntry(language = "vi", model = "vinai_PhoWhisper-medium"),
        AsrLanguageModelEntry(language = "en", model = "base"),
        AsrLanguageModelEntry(language = "ja", model = ""),
    )

    @Test
    fun `fixed mode sends the chosen model`() {
        assertThat(AsrModelSelection.resolve("fixed", "medium", map, detectedLanguage = "vi"))
            .isEqualTo("medium")
    }

    @Test
    fun `fixed mode with nothing chosen leaves the model to the server`() {
        assertThat(AsrModelSelection.resolve("fixed", "", map, detectedLanguage = null)).isNull()
        assertThat(AsrModelSelection.resolve("fixed", "   ", map, detectedLanguage = null)).isNull()
    }

    @Test
    fun `routing mode maps the detected language to its model`() {
        assertThat(AsrModelSelection.resolve("routing", "medium", map, detectedLanguage = "vi"))
            .isEqualTo("vinai_PhoWhisper-medium")
        assertThat(AsrModelSelection.resolve("routing", "medium", map, detectedLanguage = "EN"))
            .isEqualTo("base")
    }

    @Test
    fun `routing mode falls back to the server default, never to the fixed model`() {
        assertThat(AsrModelSelection.resolve("routing", "medium", map, detectedLanguage = "fr")).isNull()
        assertThat(AsrModelSelection.resolve("routing", "medium", map, detectedLanguage = "ja")).isNull()
        assertThat(AsrModelSelection.resolve("routing", "medium", map, detectedLanguage = null)).isNull()
    }

    @Test
    fun `language detection is only worth a round trip with a usable mapping`() {
        assertThat(AsrModelSelection.needsLanguageDetection("routing", map)).isTrue()
        assertThat(AsrModelSelection.needsLanguageDetection("fixed", map)).isFalse()
        assertThat(AsrModelSelection.needsLanguageDetection("routing", emptyList())).isFalse()
        assertThat(AsrModelSelection.needsLanguageDetection(
            "routing", listOf(AsrLanguageModelEntry(language = "ja", model = "")),
        )).isFalse()
    }

    @Test
    fun `mapped languages are the trimmed, distinct, non-blank ones`() {
        val entries = map + AsrLanguageModelEntry(language = " vi ", model = "base") +
            AsrLanguageModelEntry(language = "", model = "base")
        assertThat(AsrModelSelection.mappedLanguages(entries)).containsExactly("vi", "en", "ja").inOrder()
    }
}
