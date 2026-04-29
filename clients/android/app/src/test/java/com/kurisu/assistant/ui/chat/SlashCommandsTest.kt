package com.kurisu.assistant.ui.chat

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class SlashCommandsTest {

    @Test
    fun `parse returns null for plain text`() {
        assertThat(SlashCommands.parse("hello world")).isNull()
        assertThat(SlashCommands.parse("")).isNull()
        assertThat(SlashCommands.parse("/")).isNull()
    }

    @Test
    fun `parse matches known commands case-insensitively`() {
        val (cmd, args) = SlashCommands.parse("/clear")!!
        assertThat(cmd.name).isEqualTo("clear")
        assertThat(args).isEmpty()

        val (cmd2, _) = SlashCommands.parse("/CLEAR")!!
        assertThat(cmd2.name).isEqualTo("clear")
    }

    @Test
    fun `parse extracts trailing args`() {
        val (cmd, args) = SlashCommands.parse("/compact some extra text")!!
        assertThat(cmd.name).isEqualTo("compact")
        assertThat(args).isEqualTo("some extra text")
    }

    @Test
    fun `parse returns null for unknown commands so they fall through`() {
        // Matches desktop: unknown /foo is not intercepted client-side.
        assertThat(SlashCommands.parse("/notarealcommand")).isNull()
    }

    @Test
    fun `autocomplete returns empty when text does not start with slash`() {
        assertThat(SlashCommands.autocomplete("hello")).isEmpty()
    }

    @Test
    fun `autocomplete filters by prefix`() {
        val matches = SlashCommands.autocomplete("/c")
        val names = matches.map { it.name }
        assertThat(names).containsAtLeast("clear", "context", "compact")
        assertThat(names).doesNotContain("delete")
    }

    @Test
    fun `autocomplete returns full list for bare slash`() {
        val matches = SlashCommands.autocomplete("/")
        assertThat(matches).hasSize(SlashCommands.ALL.size)
    }
}
