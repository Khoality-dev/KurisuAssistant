package com.kurisu.assistant.domain.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AudioRecorder @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    companion object {
        private const val TAG = "AudioRecorder"
        const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val CHUNK_SIZE_SAMPLES = 512 // ~32ms at 16kHz, matches Silero window
    }

    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _audioChunks = MutableSharedFlow<ShortArray>(extraBufferCapacity = 64)
    val audioChunks: Flow<ShortArray> = _audioChunks

    // Accumulated raw PCM for ASR transcription
    private val accumulatedPcm = mutableListOf<ShortArray>()
    var isRecording = false
        private set

    fun start(): Boolean {
        if (isRecording) return true
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "Microphone permission not granted")
            return false
        }

        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
            .coerceAtLeast(CHUNK_SIZE_SAMPLES * 2)

        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize,
        )

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            record.release()
            return false
        }

        audioRecord = record
        record.startRecording()
        isRecording = true
        accumulatedPcm.clear()

        recordingJob = scope.launch {
            val buffer = ShortArray(CHUNK_SIZE_SAMPLES)
            while (isActive && isRecording) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    val chunk = buffer.copyOf(read)
                    accumulatedPcm.add(chunk)
                    _audioChunks.tryEmit(chunk)
                }
            }
        }

        return true
    }

    fun stop(): ByteArray {
        isRecording = false
        recordingJob?.cancel()
        recordingJob = null
        audioRecord?.let {
            try {
                it.stop()
                it.release()
            } catch (_: Exception) {}
        }
        audioRecord = null

        return getAccumulatedWav()
    }

    fun release() {
        stop()
        scope.cancel()
    }

    /** Get accumulated PCM as WAV bytes for ASR transcription */
    private fun getAccumulatedWav(): ByteArray {
        val totalSamples = accumulatedPcm.sumOf { it.size }
        val pcmBytes = ByteArray(totalSamples * 2)
        var offset = 0
        for (chunk in accumulatedPcm) {
            for (sample in chunk) {
                pcmBytes[offset++] = (sample.toInt() and 0xFF).toByte()
                pcmBytes[offset++] = (sample.toInt() shr 8 and 0xFF).toByte()
            }
        }
        accumulatedPcm.clear()

        // Create WAV header
        val wavHeader = createWavHeader(pcmBytes.size, SAMPLE_RATE, 1, 16)
        return wavHeader + pcmBytes
    }

    fun clearAccumulated() {
        accumulatedPcm.clear()
    }

    private fun createWavHeader(dataSize: Int, sampleRate: Int, channels: Int, bitsPerSample: Int): ByteArray {
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val totalSize = 36 + dataSize

        return byteArrayOf(
            'R'.code.toByte(), 'I'.code.toByte(), 'F'.code.toByte(), 'F'.code.toByte(),
            (totalSize and 0xFF).toByte(), (totalSize shr 8 and 0xFF).toByte(),
            (totalSize shr 16 and 0xFF).toByte(), (totalSize shr 24 and 0xFF).toByte(),
            'W'.code.toByte(), 'A'.code.toByte(), 'V'.code.toByte(), 'E'.code.toByte(),
            'f'.code.toByte(), 'm'.code.toByte(), 't'.code.toByte(), ' '.code.toByte(),
            16, 0, 0, 0, // Subchunk1Size (PCM)
            1, 0, // AudioFormat (PCM)
            (channels and 0xFF).toByte(), 0,
            (sampleRate and 0xFF).toByte(), (sampleRate shr 8 and 0xFF).toByte(),
            (sampleRate shr 16 and 0xFF).toByte(), (sampleRate shr 24 and 0xFF).toByte(),
            (byteRate and 0xFF).toByte(), (byteRate shr 8 and 0xFF).toByte(),
            (byteRate shr 16 and 0xFF).toByte(), (byteRate shr 24 and 0xFF).toByte(),
            (blockAlign and 0xFF).toByte(), 0,
            (bitsPerSample and 0xFF).toByte(), 0,
            'd'.code.toByte(), 'a'.code.toByte(), 't'.code.toByte(), 'a'.code.toByte(),
            (dataSize and 0xFF).toByte(), (dataSize shr 8 and 0xFF).toByte(),
            (dataSize shr 16 and 0xFF).toByte(), (dataSize shr 24 and 0xFF).toByte(),
        )
    }
}
