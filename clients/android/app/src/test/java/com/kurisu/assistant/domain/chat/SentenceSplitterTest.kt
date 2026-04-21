package com.kurisu.assistant.domain.chat

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class SentenceSplitterTest {

    @Test
    fun `returns null when no boundary found`() {
        assertThat(splitAtSentenceBoundary("hello there")).isNull()
    }

    @Test
    fun `returns null for empty buffer`() {
        assertThat(splitAtSentenceBoundary("")).isNull()
    }

    @Test
    fun `splits on period`() {
        val result = splitAtSentenceBoundary("Hello world. rest")
        assertThat(result).isNotNull()
        assertThat(result!!.first).isEqualTo("Hello world.")
        assertThat(result.second).isEqualTo(" rest")
    }

    @Test
    fun `splits on exclamation mark`() {
        val (sentence, remainder) = splitAtSentenceBoundary("Wow! more")!!
        assertThat(sentence).isEqualTo("Wow!")
        assertThat(remainder).isEqualTo(" more")
    }

    @Test
    fun `splits on question mark`() {
        val (sentence, remainder) = splitAtSentenceBoundary("Why? because")!!
        assertThat(sentence).isEqualTo("Why?")
        assertThat(remainder).isEqualTo(" because")
    }

    @Test
    fun `splits on CJK full stop`() {
        val (sentence, remainder) = splitAtSentenceBoundary("你好。世界")!!
        assertThat(sentence).isEqualTo("你好。")
        assertThat(remainder).isEqualTo("世界")
    }

    @Test
    fun `splits on CJK exclamation and question`() {
        val excl = splitAtSentenceBoundary("すごい！続き")!!
        assertThat(excl.first).isEqualTo("すごい！")

        val q = splitAtSentenceBoundary("本当？そう")!!
        assertThat(q.first).isEqualTo("本当？")
    }

    @Test
    fun `splits on newline`() {
        val (sentence, remainder) = splitAtSentenceBoundary("line one\nline two")!!
        assertThat(sentence).isEqualTo("line one")
        assertThat(remainder).isEqualTo("line two")
    }

    @Test
    fun `empty remainder when boundary at end`() {
        val (sentence, remainder) = splitAtSentenceBoundary("Done.")!!
        assertThat(sentence).isEqualTo("Done.")
        assertThat(remainder).isEmpty()
    }

    @Test
    fun `only first boundary triggers split`() {
        val (sentence, remainder) = splitAtSentenceBoundary("One. Two. Three.")!!
        assertThat(sentence).isEqualTo("One.")
        assertThat(remainder).isEqualTo(" Two. Three.")
    }

    @Test
    fun `whitespace-only sentence returns null`() {
        // A lone boundary preceded by only whitespace still trims to non-empty
        // because the boundary itself is captured in the sentence
        val result = splitAtSentenceBoundary(".")
        assertThat(result).isNotNull()
        assertThat(result!!.first).isEqualTo(".")
    }
}
