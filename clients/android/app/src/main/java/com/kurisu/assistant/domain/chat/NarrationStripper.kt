package com.kurisu.assistant.domain.chat

/**
 * Strip action narration (*walks over*, *sighs*) from TTS text.
 * Preserves **bold** markdown.
 */
private val NARRATION_PATTERN = Regex("(?<!\\*)\\*(?!\\*)([^*]+)\\*(?!\\*)")

fun stripNarration(text: String): String =
    NARRATION_PATTERN.replace(text, "").trim()
