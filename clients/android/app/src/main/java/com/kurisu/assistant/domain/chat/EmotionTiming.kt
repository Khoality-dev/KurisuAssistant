package com.kurisu.assistant.domain.chat

import com.kurisu.assistant.data.model.EmotionCue
import com.kurisu.assistant.domain.character.vrm.VRM_EMOTIONS
import com.kurisu.assistant.domain.tts.SegmentCue

/**
 * When a feeling reaches the face (#244, #246).
 *
 * The backend reports each feeling the model wrote as a cue on the chunk whose
 * text starts where it takes effect: `emotion_at`, an offset into the current
 * LLM round's text in UTF-16 code units — `String.length` here (#243). Text
 * streams seconds ahead of speech, so a cue rides the sentence it falls in, at
 * its fraction of the way through, and the character page shows it when the
 * audio gets there. These are the desktop's rules (`@kurisu/hooks`
 * `emotionTiming.ts`); with speech off Android shows no feeling yet.
 */

/**
 * The cues of `[start, end)` of a round's text, as fractions of that span.
 *
 * When the span opens without a cue of its own, the feeling in force there —
 * the last cue before [start] — is put at its start, unless it is what the
 * previous sentence spoken already ended on.
 */
fun selectCuesForSegment(cues: List<EmotionCue>, start: Int, end: Int, previousEnded: String?): List<SegmentCue> {
    if (end <= start) return emptyList()
    val span = (end - start).toDouble()
    val inside = cues
        .filter { it.at in start until end }
        .sortedBy { it.at }
        .map { SegmentCue(it.emotion, (it.at - start) / span) }
    if (inside.isNotEmpty() && inside.first().atFraction == 0.0) return inside
    var inForce: String? = null
    var inForceAt = -1
    for (c in cues) {
        if (c.at < start && c.at >= inForceAt) {
            inForce = c.emotion
            inForceAt = c.at
        }
    }
    return if (inForce != null && inForce != previousEnded) listOf(SegmentCue(inForce, 0.0)) + inside else inside
}

/**
 * The stream's cues, counted against the sentences cut from it.
 * [ChatStreamProcessor] owns one: it reports each cue as it arrives and each
 * sentence's raw length as it is cut, and starts a new run at every new bubble,
 * because the backend's offsets restart with every LLM round.
 */
class SpeechCuePlanner {
    private val cues = mutableListOf<EmotionCue>()
    /** Where the next sentence starts in the round's text. */
    private var consumed = 0
    private var previousEnded: String? = null

    /** A cue from a chunk. A label the face has no expression for is dropped here. */
    fun cue(emotion: String, at: Int) {
        if (emotion in VRM_EMOTIONS) cues += EmotionCue(emotion, at)
    }

    /**
     * The cues of the next [rawLength] code units of the round. [spoken] is false
     * for a sentence narration swallowed: its feeling stays in force and opens
     * the next sentence that is spoken.
     */
    fun take(rawLength: Int, spoken: Boolean): List<SegmentCue> {
        val start = consumed
        consumed += rawLength
        val selected = selectCuesForSegment(cues, start, consumed, previousEnded)
        if (spoken && selected.isNotEmpty()) previousEnded = selected.last().emotion
        return selected
    }

    /** A new bubble: the offsets start again from zero. */
    fun newRun() {
        cues.clear()
        consumed = 0
    }

    /** A cancel or the end of the turn: nothing carries over. */
    fun reset() {
        newRun()
        previousEnded = null
    }
}
