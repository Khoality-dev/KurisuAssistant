package com.kurisu.assistant.domain.tts

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WavParserTest {

    /** Build a minimal RIFF/WAVE/fmt /data WAV with 16-bit PCM samples. */
    private fun buildWav16(sampleRate: Int, channels: Int, samples: ShortArray): ByteArray {
        val dataSize = samples.size * 2
        val buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray())
        buf.putInt(36 + dataSize)
        buf.put("WAVE".toByteArray())
        buf.put("fmt ".toByteArray())
        buf.putInt(16)             // fmt chunk size
        buf.putShort(1)            // PCM format
        buf.putShort(channels.toShort())
        buf.putInt(sampleRate)
        buf.putInt(sampleRate * channels * 2) // byte rate
        buf.putShort((channels * 2).toShort()) // block align
        buf.putShort(16)           // bits per sample
        buf.put("data".toByteArray())
        buf.putInt(dataSize)
        samples.forEach { buf.putShort(it) }
        return buf.array()
    }

    private fun build8BitWav(sampleRate: Int, samples: ByteArray): ByteArray {
        val dataSize = samples.size
        val buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray())
        buf.putInt(36 + dataSize)
        buf.put("WAVE".toByteArray())
        buf.put("fmt ".toByteArray())
        buf.putInt(16)
        buf.putShort(1)
        buf.putShort(1)
        buf.putInt(sampleRate)
        buf.putInt(sampleRate)
        buf.putShort(1)
        buf.putShort(8)
        buf.put("data".toByteArray())
        buf.putInt(dataSize)
        buf.put(samples)
        return buf.array()
    }

    @Test
    fun `returns null for buffer smaller than header`() {
        assertThat(parseWavPcm(ByteArray(10))).isNull()
        assertThat(getWavDuration(ByteArray(10))).isNull()
    }

    @Test
    fun `returns null when RIFF magic missing`() {
        val bytes = ByteArray(44)
        assertThat(parseWavPcm(bytes)).isNull()
    }

    @Test
    fun `parses 16-bit mono PCM samples`() {
        val wav = buildWav16(16000, 1, shortArrayOf(0, 16384, -16384, 32767, -32768))
        val result = parseWavPcm(wav)
        assertThat(result).isNotNull()
        assertThat(result!!.sampleRate).isEqualTo(16000)
        assertThat(result.samples.size).isEqualTo(5)
        assertThat(result.samples[0]).isWithin(1e-4f).of(0f)
        assertThat(result.samples[1]).isWithin(1e-3f).of(0.5f)
        assertThat(result.samples[2]).isWithin(1e-3f).of(-0.5f)
        assertThat(result.samples[3]).isWithin(1e-3f).of(0.99997f)
        assertThat(result.samples[4]).isWithin(1e-3f).of(-1.0f)
    }

    @Test
    fun `parses 8-bit PCM samples`() {
        val wav = build8BitWav(8000, byteArrayOf(128.toByte(), 0, 255.toByte()))
        val result = parseWavPcm(wav)
        assertThat(result).isNotNull()
        assertThat(result!!.samples[0]).isWithin(1e-3f).of(0f)
        assertThat(result.samples[1]).isWithin(1e-3f).of(-1.0f)
        assertThat(result.samples[2]).isWithin(1e-2f).of(0.99f)
    }

    @Test
    fun `computes duration from 16-bit mono WAV`() {
        val samples = ShortArray(16000) { 0 } // exactly 1 second at 16kHz
        val wav = buildWav16(16000, 1, samples)
        val duration = getWavDuration(wav)
        assertThat(duration).isNotNull()
        assertThat(duration!!).isWithin(1e-3f).of(1.0f)
    }

    @Test
    fun `handles multi-channel WAV`() {
        // stereo: 4 samples per channel = 8 shorts
        val wav = buildWav16(44100, 2, shortArrayOf(0, 0, 100, 100, 0, 0, -100, -100))
        val result = parseWavPcm(wav)
        assertThat(result).isNotNull()
        assertThat(result!!.sampleRate).isEqualTo(44100)
        // totalSamples = dataSize / (bytesPerSample * numChannels) = 16 / (2*2) = 4
        assertThat(result.samples.size).isEqualTo(4)
    }
}
