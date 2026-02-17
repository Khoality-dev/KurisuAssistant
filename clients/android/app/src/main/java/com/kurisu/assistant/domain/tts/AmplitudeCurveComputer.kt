package com.kurisu.assistant.domain.tts

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sqrt

data class AmplitudeCurve(
    val values: FloatArray,
    val windowDurationMs: Float,
)

/**
 * Pre-compute RMS amplitude per ~33ms window from raw PCM samples.
 * Pure math — no platform dependencies.
 */
fun computeRMSCurve(samples: FloatArray, sampleRate: Int): AmplitudeCurve {
    val windowSamples = floor(sampleRate / 30.0).toInt()
    val numWindows = ceil(samples.size.toDouble() / windowSamples).toInt()
    val values = FloatArray(numWindows)

    for (w in 0 until numWindows) {
        val start = w * windowSamples
        val end = min(start + windowSamples, samples.size)
        var sumSquares = 0f
        for (i in start until end) {
            sumSquares += samples[i] * samples[i]
        }
        val rms = sqrt(sumSquares / (end - start))
        values[w] = min(rms * 4f, 1.0f)
    }

    return AmplitudeCurve(values, windowSamples.toFloat() / sampleRate * 1000f)
}
