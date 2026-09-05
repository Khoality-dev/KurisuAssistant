package com.kurisu.assistant.ui.common

/**
 * The monogram shown for a persona (or a sub-agent) that has no avatar.
 *
 * The rule is the FIRST LETTER of each of the first two whitespace-, hyphen- or
 * underscore-separated tokens, falling back to the first two letters of a
 * single-token name: `code-reader` is CR, `Kurisu` is KU.
 *
 * The design's initials were hand-authored — it draws "Coach" as CH — and are
 * not derivable from the name, so they are not reproduced. A rule that lied
 * about one persona would lie about every persona the user invents at runtime.
 *
 * This lives in `ui/common` because three screens draw the same face: the chat
 * transcript, the Chats list and the persona editors. Three copies of the rule
 * is three chances for it to drift.
 */
fun personaInitials(name: String?): String {
    val tokens = name.orEmpty().trim().split(TOKEN_SEPARATOR).filter { it.isNotBlank() }
    return when {
        tokens.size >= 2 -> "${tokens[0].first()}${tokens[1].first()}".uppercase()
        tokens.size == 1 -> tokens[0].take(2).uppercase()
        else -> "?"
    }
}

private val TOKEN_SEPARATOR = Regex("[\\s\\-_]+")
