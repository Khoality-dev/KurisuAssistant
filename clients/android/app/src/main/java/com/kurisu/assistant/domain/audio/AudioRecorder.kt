package com.kurisu.assistant.domain.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
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
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _audioChunks = MutableSharedFlow<ShortArray>(extraBufferCapacity = 64)
    val audioChunks: Flow<ShortArray> = _audioChunks

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    // Accumulated raw PCM for ASR transcription
    private val accumulatedPcm = mutableListOf<ShortArray>()
    var isRecording = false
        private set

    // Preferred input device type (-1 = default/auto)
    var preferredDeviceType: Int = -1

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

        // Set preferred input device if configured
        if (preferredDeviceType >= 0) {
            val device = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
                .firstOrNull { it.type == preferredDeviceType }
            if (device != null) {
                record.setPreferredDevice(device)
                Log.d(TAG, "Set preferred input device: ${device.productName} (type=$preferredDeviceType)")
            } else {
                Log.w(TAG, "Preferred device type $preferredDeviceType not found, using default")
            }
        }

        audioRecord = record
        record.startRecording()
        isRecording = true
        accumulatedPcm.clear()
        Log.d(TAG, "Recording started: sampleRate=${record.sampleRate}, channelCount=${record.channelCount}, bufferSize=$bufferSize")

        recordingJob = scope.launch {
            val buffer = ShortArray(CHUNK_SIZE_SAMPLES)
            while (isActive && isRecording) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    val chunk = buffer.copyOf(read)
                    synchronized(accumulatedPcm) { accumulatedPcm.add(chunk) }
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

        return takeAccumulatedPcm()
    }

    fun release() {
        stop()
        scope.cancel()
    }

    /** Snapshot and clear accumulated audio without stopping recording. */
    fun takeAccumulatedPcm(): ByteArray {
        return synchronized(accumulatedPcm) {
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
            pcmBytes
        }
    }

    fun clearAccumulated() {
        synchronized(accumulatedPcm) { accumulatedPcm.clear() }
    }

    /** List available audio input devices as (type, displayName) pairs */
    fun getInputDevices(): List<Pair<Int, String>> {
        return audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).map { device ->
            val name = device.productName.toString().ifBlank { deviceTypeName(device.type) }
            device.type to name
        }.distinctBy { it.first }
    }

    companion object {
        private const val TAG = "AudioRecorder"
        const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val CHUNK_SIZE_SAMPLES = 512 // ~32ms at 16kHz, matches Silero window

        fun deviceTypeName(type: Int): String = when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "USB Device"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Headset"
            AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony"
            AudioDeviceInfo.TYPE_IP -> "IP"
            else -> "Unknown ($type)"
        }
    }
}
