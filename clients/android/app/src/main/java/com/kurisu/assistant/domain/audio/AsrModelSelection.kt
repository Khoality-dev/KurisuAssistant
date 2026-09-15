package com.kurisu.assistant.domain.audio

import com.kurisu.assistant.data.model.AsrLanguageModelEntry

/**
 * Which ASR model a clip should be transcribed with, from the Speech settings.
 *
 * Mirrors the desktop's `micStore`: in `fixed` mode the one chosen model (blank
 * means the server's default); in `routing` mode the server first names the
 * language and the per-language table picks the model. Pure, so the rule is
 * unit-tested without a service or a microphone. The settings were stored and
 * shown on Android but never reached a request (#200).
 */
object AsrModelSelection {
    const val MODE_FIXED = "fixed"
    const val MODE_ROUTING = "routing"

    /** Whether a language-detection round trip is needed before transcribing. */
    fun needsLanguageDetection(mode: String, modelMap: List<AsrLanguageModelEntry>): Boolean =
        mode == MODE_ROUTING && modelMap.any { it.language.isNotBlank() && it.model.isNotBlank() }

    /**
     * The model id to send, or null for the server's default.
     *
     * [detectedLanguage] is only consulted in routing mode; a language with no
     * mapping, or no detection at all, falls back to the server default rather
     * than to the fixed model, which the user did not choose for this mode.
     */
    fun resolve(
        mode: String,
        fixedModel: String,
        modelMap: List<AsrLanguageModelEntry>,
        detectedLanguage: String?,
    ): String? {
        if (mode != MODE_ROUTING) return fixedModel.ifBlank { null }
        val language = detectedLanguage?.trim()?.ifBlank { null } ?: return null
        return modelMap
            .firstOrNull { it.language.trim().equals(language, ignoreCase = true) && it.model.isNotBlank() }
            ?.model
    }

    /** The languages the routing table knows, for the detector to choose among. */
    fun mappedLanguages(modelMap: List<AsrLanguageModelEntry>): List<String> =
        modelMap.map { it.language.trim() }.filter { it.isNotBlank() }.distinct()
}
