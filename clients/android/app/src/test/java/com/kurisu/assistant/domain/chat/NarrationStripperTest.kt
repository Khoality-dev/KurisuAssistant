package com.kurisu.assistant.domain.chat

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class NarrationStripperTest {

    @Test
    fun `removes single-asterisk narration`() {
        val result = stripNarration("Hello *waves* there")
        assertThat(result).isEqualTo("Hello  there")
    }

    @Test
    fun `preserves bold markdown`() {
        val result = stripNarration("This is **bold** text")
        assertThat(result).isEqualTo("This is **bold** text")
    }

    @Test
    fun `strips multiple narrations but keeps bold`() {
        val result = stripNarration("*sighs* Fine, **very well** *walks away*")
        assertThat(result).isEqualTo("Fine, **very well**")
    }

    @Test
    fun `handles empty string`() {
        assertThat(stripNarration("")).isEmpty()
    }

    @Test
    fun `returns plain text unchanged`() {
        assertThat(stripNarration("Just plain text")).isEqualTo("Just plain text")
    }

    @Test
    fun `trims surrounding whitespace after stripping`() {
        val result = stripNarration("*ahem*   hello")
        assertThat(result).isEqualTo("hello")
    }

    @Test
    fun `adjacent narrations without separator are not stripped`() {
        // The lookaround guard `(?<!\*)\*(?!\*)` prevents matching when the closing `*` is
        // adjacent to another `*`. This is intentional: ambiguous sequences like `*a**b*`
        // could collide with bold markdown, so we leave them alone.
        val result = stripNarration("*one**two*")
        assertThat(result).isEqualTo("*one**two*")
    }

    @Test
    fun `narrations separated by whitespace are both stripped`() {
        val result = stripNarration("*one* *two*")
        assertThat(result).isEmpty()
    }

    @Test
    fun `narration with spaces inside is removed`() {
        val result = stripNarration("*walks over slowly* Hi")
        assertThat(result).isEqualTo("Hi")
    }

    @Test
    fun `handles lone asterisks gracefully`() {
        // Lone asterisks don't form narration and shouldn't crash
        val result = stripNarration("a * b")
        assertThat(result).isEqualTo("a * b")
    }
}
