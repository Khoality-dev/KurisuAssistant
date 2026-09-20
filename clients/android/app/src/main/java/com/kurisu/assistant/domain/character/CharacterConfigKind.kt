package com.kurisu.assistant.domain.character

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Which character system a persona's `character_config` names — read once, here,
 * instead of every screen looking for `pose_tree` by hand (#235).
 *
 * The backend stamps every config with a `kind` and refuses a save without one
 * (wire protocol 7), so there is no kind-less fallback: a config this build cannot
 * classify is [UNSUPPORTED], never guessed at. A [VRM] config is one this build
 * recognises but cannot draw yet — the sheet says so and points at an update,
 * where it used to say "no character configured" while the persona list said
 * "character".
 */
enum class CharacterConfigKind {
    /** No config, or a pose-graph config with no tree in it. */
    NONE,
    POSE_GRAPH,
    /** A 3D model. Recognised, not rendered on this build. */
    VRM,
    /** A kind this build does not know, or a config it will not trust. */
    UNSUPPORTED;

    val isConfigured: Boolean get() = this != NONE

    companion object {
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val CLIP_ID = Regex("^[0-9a-f]{8}$")

        fun of(config: JsonObject?): CharacterConfigKind {
            if (config == null) return NONE
            return when ((config["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
                "pose_graph" -> if (config["pose_tree"] is JsonObject) POSE_GRAPH else NONE
                "vrm" -> if (vrmRefsAreSane(config["vrm"])) VRM else UNSUPPORTED
                else -> UNSUPPORTED
            }
        }

        /**
         * The server-owned references inside a VRM member are the strings a
         * renderer will one day turn into file names on this device; a config
         * whose `sha256` or clip id is not what the server promises is refused
         * here rather than trusted later.
         */
        private fun vrmRefsAreSane(vrm: kotlinx.serialization.json.JsonElement?): Boolean {
            if (vrm == null || vrm is JsonNull) return true
            if (vrm !is JsonObject) return false
            val model = vrm["model"]
            if (model != null && model !is JsonNull) {
                if (model !is JsonObject) return false
                if (!matches(model["sha256"], SHA256)) return false
            }
            val clips = vrm["clips"]
            if (clips != null && clips !is JsonNull) {
                if (clips !is JsonArray) return false
                for (clip in clips) {
                    if (clip !is JsonObject) return false
                    if (!matches(clip["id"], CLIP_ID) || !matches(clip["sha256"], SHA256)) return false
                }
            }
            return true
        }

        private fun matches(value: kotlinx.serialization.json.JsonElement?, regex: Regex): Boolean {
            val primitive = value as? JsonPrimitive ?: return false
            return primitive.isString && regex.matches(primitive.content)
        }
    }
}

/** What the character sheet says instead of a picture, per kind; null when it can draw one. */
fun CharacterConfigKind.unrenderableMessage(): String? = when (this) {
    CharacterConfigKind.NONE -> "This persona has no character configured."
    CharacterConfigKind.VRM -> "3D character — update the app to see it."
    CharacterConfigKind.UNSUPPORTED -> "This character needs a newer app."
    CharacterConfigKind.POSE_GRAPH -> null
}

/** The persona list's word for it: `character`, `3D character`, or nothing. */
fun CharacterConfigKind.metaLabel(): String? = when (this) {
    CharacterConfigKind.NONE -> null
    CharacterConfigKind.POSE_GRAPH -> "character"
    CharacterConfigKind.VRM -> "3D character"
    CharacterConfigKind.UNSUPPORTED -> "character (needs update)"
}

/** The persona editor's status for the character row. */
fun CharacterConfigKind.rowStatus(): String = when (this) {
    CharacterConfigKind.NONE -> "None"
    CharacterConfigKind.POSE_GRAPH -> "Configured"
    CharacterConfigKind.VRM -> "3D model"
    CharacterConfigKind.UNSUPPORTED -> "Needs update"
}
