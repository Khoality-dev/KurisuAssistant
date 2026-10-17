package com.kurisu.assistant.domain.character.vrm

import com.kurisu.assistant.data.model.Message
import com.kurisu.assistant.domain.tts.SpeechSegment
import com.kurisu.assistant.domain.tts.SpeechSync
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** The VRM expression presets a feeling may name (`@kurisu/models` `VRM_EMOTIONS`). */
val VRM_EMOTIONS = setOf("neutral", "happy", "angry", "sad", "relaxed", "surprised")

/**
 * The messages Android pushes to the character page (#246), in the page's own
 * shapes (`clients/packages/vrm/src/page/host.ts`). The page validates every
 * message and drops one it cannot read whole, so a feeling it has no
 * expression for is filtered out here rather than costing a sentence its mouth.
 */
object BridgeMessages {
    /** host.ts `HOST_MESSAGE_TYPES`. */
    val TYPES = listOf("config", "speech", "speech-sync", "feed", "gestures", "faces", "subtitle", "resting")

    /** The persona's `character_config`, verbatim: the page parses it as the desktop does. */
    fun config(character: JsonObject?, personaName: String?): JsonObject = buildJsonObject {
        put("t", "config")
        put("personaName", personaName)
        put("character", character ?: JsonNull)
    }

    /** The sentence now playing, or null once speech has ended. */
    fun speech(segment: SpeechSegment?): JsonObject = buildJsonObject {
        put("t", "speech")
        if (segment == null) {
            put("segment", JsonNull)
            return@buildJsonObject
        }
        putJsonObject("segment") {
            put("text", segment.text)
            put("startedAt", segment.startedAt)
            put("durationMs", segment.durationMs)
            put("windowMs", segment.windowMs)
            val curve = segment.curve
            if (curve == null) put("curve", JsonNull) else putJsonArray("curve") { curve.forEach { add(it) } }
            putJsonArray("cues") {
                segment.cues.filter { it.emotion in VRM_EMOTIONS }.forEach { cue ->
                    addJsonObject {
                        put("emotion", cue.emotion)
                        put("delayMs", cue.delayMs)
                    }
                }
            }
        }
    }

    fun speechSync(sync: SpeechSync): JsonObject = buildJsonObject {
        put("t", "speech-sync")
        putJsonObject("sync") {
            put("positionMs", sync.positionMs)
            put("at", sync.at)
        }
    }

    /** The reply is streaming, so the character is thinking. */
    fun feed(isThinking: Boolean): JsonObject = buildJsonObject {
        put("t", "feed")
        put("isThinking", isThinking)
    }

    /** One camera result's gestures; [seq] rises with every result so the page takes each burst once. */
    fun gestures(names: List<String>, seq: Long): JsonObject = buildJsonObject {
        put("t", "gestures")
        putJsonArray("names") { names.forEach { add(it) } }
        put("seq", seq)
    }

    fun faces(names: List<String>): JsonObject = buildJsonObject {
        put("t", "faces")
        putJsonArray("names") { names.forEach { add(it) } }
    }

    fun subtitle(text: String, isUser: Boolean, durationMs: Long?): JsonObject = buildJsonObject {
        put("t", "subtitle")
        put("text", text)
        put("isUser", isUser)
        put("durationMs", durationMs)
    }

    /** The face between cues; null for a label the page would refuse. */
    fun resting(emotion: String): JsonObject? {
        if (emotion !in VRM_EMOTIONS) return null
        return buildJsonObject {
            put("t", "resting")
            put("emotion", emotion)
        }
    }
}

/**
 * The feeling a reopened conversation rests on: the last cue of the last
 * assistant message, when that message is [personaId]'s. Scroll-back replays
 * nothing (the desktop's `restingCueOf`).
 */
fun restingEmotionOf(messages: List<Message>, personaId: Int?): String? {
    if (personaId == null) return null
    val last = messages.lastOrNull { it.role == "assistant" } ?: return null
    if (last.personaId != personaId) return null
    return last.emotionCues?.lastOrNull()?.emotion
}
