package com.kurisu.assistant.domain.chat

/** Sentence-boundary regex for TTS splitting */
private val SENTENCE_BOUNDARY = Regex("[.!?。！？\\n]")

/**
 * Split text at sentence boundaries for streaming TTS.
 * Returns the sentence to queue and any remaining buffer, or null if no boundary found.
 */
fun splitAtSentenceBoundary(buffer: String): Pair<String, String>? {
    val match = SENTENCE_BOUNDARY.find(buffer) ?: return null
    val endIdx = match.range.last + 1
    val sentence = buffer.substring(0, endIdx).trim()
    val remainder = buffer.substring(endIdx)
    if (sentence.isEmpty()) return null
    return sentence to remainder
}
