package com.kurisu.assistant.domain.tts

import kotlin.math.roundToLong

/** A feeling inside a sentence the stream handed to the TTS queue, as a fraction of the way through it. */
data class SegmentCue(val emotion: String, val atFraction: Double)

/** A feeling inside a sentence being spoken, at its delay into the audio. */
data class SpeechCue(val emotion: String, val delayMs: Long)

/**
 * One sentence as it is played — the desktop's `SpeechSegment` (`@kurisu/models`
 * `speech.ts`), which the character page clocks its mouth and its cues from
 * (#246). Pushed once per sentence: the page runs the curve itself rather than
 * being sent an amplitude thirty times a second.
 */
class SpeechSegment(
    val text: String,
    /** `System.currentTimeMillis()` taken after `MediaPlayer.start()` returned — never before. */
    val startedAt: Long,
    val durationMs: Long,
    val windowMs: Double,
    /** RMS per window, 0..1; null when the WAV could not be read and the mouth stays shut. */
    val curve: FloatArray?,
    val cues: List<SpeechCue>,
)

/** A low-rate correction from the player's own position, so output latency is absorbed. */
data class SpeechSync(val positionMs: Long, val at: Long)

/** How often the player's position is sent to the page while a sentence plays. */
const val SPEECH_SYNC_INTERVAL_MS = 500L

/** The segment for a sentence whose playback just started. */
fun speechSegmentOf(
    text: String,
    startedAt: Long,
    durationMs: Long,
    curve: AmplitudeCurve?,
    cues: List<SegmentCue>,
): SpeechSegment = SpeechSegment(
    text = text,
    startedAt = startedAt,
    durationMs = durationMs,
    windowMs = curve?.windowDurationMs?.toDouble() ?: (1000.0 / 30),
    curve = curve?.values,
    cues = cues.map { SpeechCue(it.emotion, (it.atFraction * durationMs).roundToLong()) },
)
