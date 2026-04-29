package com.kurisu.assistant.ui.chat

/** A client-side slash command available from the chat composer. */
data class SlashCommand(
    val name: String,
    val description: String,
)

object SlashCommands {
    val ALL: List<SlashCommand> = listOf(
        SlashCommand("clear", "Start a new empty conversation"),
        SlashCommand("delete", "Permanently delete the current conversation"),
        SlashCommand("resume", "Pick a previous conversation to resume"),
        SlashCommand("context", "Show context breakdown for this chat"),
        SlashCommand("agents", "Pick an agent to chat with"),
        SlashCommand("refresh", "Reload the current conversation from the server"),
        SlashCommand("compact", "Compact the current conversation now"),
    )

    private val byName: Map<String, SlashCommand> = ALL.associateBy { it.name }

    /**
     * Parse a chat-input string. Returns the matched command + trailing arg string, or null
     * if the text is not a slash command. Unknown `/foo` strings return null so they can fall
     * through to the backend (matches desktop behavior).
     */
    fun parse(text: String): Pair<SlashCommand, String>? {
        if (!text.startsWith("/")) return null
        val body = text.removePrefix("/").trim()
        if (body.isEmpty()) return null
        val name = body.substringBefore(' ').lowercase()
        val args = body.substringAfter(' ', missingDelimiterValue = "").trim()
        val cmd = byName[name] ?: return null
        return cmd to args
    }

    /** Live autocomplete list for the composer dropdown. Empty if not in command-prefix mode. */
    fun autocomplete(text: String): List<SlashCommand> {
        if (!text.startsWith("/")) return emptyList()
        val prefix = text.removePrefix("/").substringBefore(' ').lowercase()
        return ALL.filter { it.name.startsWith(prefix) }
    }
}
