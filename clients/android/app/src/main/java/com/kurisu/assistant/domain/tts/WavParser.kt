package com.kurisu.assistant.domain.tts

import java.nio.ByteBuffer
import java.nio.ByteOrder

data class WavPcmData(
    val samples: FloatArray,
    val sampleRate: Int,
)

/**
 * Parse WAV header to get audio duration in seconds.
 */
fun getWavDuration(buffer: ByteArray): Float? {
    if (buffer.size < 44) return null
    val bb = ByteBuffer.wrap(buffer).order(ByteOrder.LITTLE_ENDIAN)

    var byteRate = 0
    var dataSize = 0
    var offset = 12

    while (offset + 8 <= buffer.size) {
        val id = String(buffer, offset, 4)
        val size = bb.getInt(offset + 4)

        if (id == "fmt ") {
            byteRate = bb.getInt(offset + 16)
        } else if (id == "data") {
            dataSize = size
            break
        }
        offset += 8 + size
        if (size % 2 != 0) offset++
    }

    if (byteRate == 0 || dataSize == 0) return null
    return dataSize.toFloat() / byteRate
}

/**
 * Parse WAV file and extract PCM samples as FloatArray.
 * Supports 8-bit, 16-bit, and 24-bit PCM WAV.
 */
fun parseWavPcm(buffer: ByteArray): WavPcmData? {
    if (buffer.size < 44) return null
    val bb = ByteBuffer.wrap(buffer).order(ByteOrder.LITTLE_ENDIAN)

    val riff = String(buffer, 0, 4)
    val wave = String(buffer, 8, 4)
    if (riff != "RIFF" || wave != "WAVE") return null

    var sampleRate = 0
    var numChannels = 0
    var bitsPerSample = 0
    var dataOffset = 0
    var dataSize = 0

    var offset = 12
    while (offset + 8 <= buffer.size) {
        val chunkId = String(buffer, offset, 4)
        val chunkSize = bb.getInt(offset + 4)

        if (chunkId == "fmt ") {
            numChannels = bb.getShort(offset + 10).toInt() and 0xFFFF
            sampleRate = bb.getInt(offset + 12)
            bitsPerSample = bb.getShort(offset + 22).toInt() and 0xFFFF
        } else if (chunkId == "data") {
            dataOffset = offset + 8
            dataSize = chunkSize
            break
        }
        offset += 8 + chunkSize
        if (chunkSize % 2 != 0) offset++
    }

    if (sampleRate == 0 || dataOffset == 0 || numChannels == 0 || bitsPerSample == 0) return null

    val bytesPerSample = bitsPerSample / 8
    val totalSamples = dataSize / (bytesPerSample * numChannels)
    val samples = FloatArray(totalSamples)

    for (i in 0 until totalSamples) {
        val bytePos = dataOffset + i * bytesPerSample * numChannels
        if (bytePos + bytesPerSample > buffer.size) break

        samples[i] = when (bitsPerSample) {
            16 -> bb.getShort(bytePos).toFloat() / 32768f
            24 -> {
                val b0 = buffer[bytePos].toInt() and 0xFF
                val b1 = buffer[bytePos + 1].toInt() and 0xFF
                val b2 = buffer[bytePos + 2].toInt() and 0xFF
                var v = (b2 shl 16) or (b1 shl 8) or b0
                if (v >= 0x800000) v -= 0x1000000
                v.toFloat() / 8388608f
            }
            8 -> ((buffer[bytePos].toInt() and 0xFF) - 128).toFloat() / 128f
            else -> return null
        }
    }

    return WavPcmData(samples, sampleRate)
}
