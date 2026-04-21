package com.kurisu.assistant.domain.tts

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class AmplitudeCurveComputerTest {

    @Test
    fun `silence produces zero amplitude`() {
        val curve = computeRMSCurve(FloatArray(16000) { 0f }, 16000)
        assertThat(curve.values).isNotEmpty()
        curve.values.forEach { assertThat(it).isEqualTo(0f) }
    }

    @Test
    fun `window duration is approximately 33ms at 16kHz`() {
        // windowSamples = floor(16000 / 30.0) = 533
        // windowDurationMs = 533 / 16000 * 1000 = 33.3125
        val curve = computeRMSCurve(FloatArray(16000) { 0f }, 16000)
        assertThat(curve.windowDurationMs).isWithin(1f).of(33f)
    }

    @Test
    fun `constant amplitude produces clamped RMS`() {
        // Full-scale constant signal -> RMS = 1.0 * 4 -> clamped to 1.0
        val samples = FloatArray(1600) { 1.0f }
        val curve = computeRMSCurve(samples, 16000)
        curve.values.forEach {
            assertThat(it).isEqualTo(1.0f)
        }
    }

    @Test
    fun `number of windows covers all samples`() {
        val samples = FloatArray(1000) { 0.1f }
        val curve = computeRMSCurve(samples, 16000)
        // windowSamples at 16kHz = 533; ceil(1000/533) = 2
        assertThat(curve.values.size).isEqualTo(2)
    }

    @Test
    fun `mid-amplitude signal scales by 4 and clamps at 1`() {
        // 0.3 constant -> rms 0.3, multiplied by 4 -> 1.2 -> clamped 1.0
        val curve = computeRMSCurve(FloatArray(600) { 0.3f }, 16000)
        assertThat(curve.values[0]).isEqualTo(1.0f)
    }

    @Test
    fun `small signal below clamp`() {
        // 0.1 constant -> rms 0.1 * 4 = 0.4
        val curve = computeRMSCurve(FloatArray(600) { 0.1f }, 16000)
        assertThat(curve.values[0]).isWithin(1e-3f).of(0.4f)
    }

    @Test
    fun `values are never negative`() {
        val samples = FloatArray(2000) { if (it % 2 == 0) -0.2f else 0.2f }
        val curve = computeRMSCurve(samples, 16000)
        curve.values.forEach { assertThat(it).isAtLeast(0f) }
    }
}
