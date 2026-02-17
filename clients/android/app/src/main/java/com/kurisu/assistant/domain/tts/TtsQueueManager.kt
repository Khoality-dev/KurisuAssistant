package com.kurisu.assistant.domain.tts

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.chat.stripNarration
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import javax.inject.Inject
import javax.inject.Singleton

data class TtsState(
    val isPlaying: Boolean = false,
    val isQueueActive: Boolean = false,
    val amplitude: Float = 0f,
    val currentText: String? = null,
)

private data class TtsQueueItem(
    val audioDeferred: Deferred<ByteArray>,
    val text: String,
)

@Singleton
class TtsQueueManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val ttsRepository: TtsRepository,
    private val prefs: PreferencesDataStore,
) {
    companion object {
        private const val TAG = "TtsQueueManager"
        private const val POLL_INTERVAL_MS = 33L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = ConcurrentLinkedQueue<TtsQueueItem>()
    private var mediaPlayer: MediaPlayer? = null
    private var amplitudeJob: Job? = null
    private var playbackJob: Job? = null
    private var isPlayingQueue = false

    private val _state = MutableStateFlow(TtsState())
    val state: StateFlow<TtsState> = _state

    // Exposed for character animation
    val amplitudeFlow: StateFlow<Float> get() = MutableStateFlow(_state.value.amplitude).also {
        // Return the amplitude from the main state
    }.let { _state.mapAmplitude() }

    private fun MutableStateFlow<TtsState>.mapAmplitude(): StateFlow<Float> {
        val ampFlow = MutableStateFlow(0f)
        scope.launch {
            this@mapAmplitude.collect { ampFlow.value = it.amplitude }
        }
        return ampFlow
    }

    fun queueText(text: String, voice: String? = null) {
        val trimmed = stripNarration(text.trim())
        if (trimmed.isBlank()) return

        val audioDeferred = scope.async {
            val backend = prefs.getTTSBackend() ?: "gpt-sovits"
            ttsRepository.synthesize(trimmed, voice, backend = backend)
        }
        queue.add(TtsQueueItem(audioDeferred, trimmed))
        _state.update { it.copy(isQueueActive = true) }

        if (!isPlayingQueue) {
            startPlayback()
        }
    }

    private fun startPlayback() {
        isPlayingQueue = true
        playbackJob = scope.launch {
            while (queue.isNotEmpty()) {
                val item = queue.poll() ?: break
                try {
                    _state.update { it.copy(currentText = item.text) }
                    val wavBytes = item.audioDeferred.await()
                    playWavBytes(wavBytes)
                } catch (e: Exception) {
                    Log.e(TAG, "TTS playback error: ${e.message}")
                }
            }
            _state.update { it.copy(isPlaying = false, isQueueActive = false, amplitude = 0f, currentText = null) }
            isPlayingQueue = false
        }
    }

    private suspend fun playWavBytes(wavBytes: ByteArray) {
        // Pre-compute amplitude curve for lip sync
        val parsed = parseWavPcm(wavBytes)
        val curve = if (parsed != null) computeRMSCurve(parsed.samples, parsed.sampleRate) else null

        // Write to temp file
        val tempFile = File(context.cacheDir, "tts_${System.currentTimeMillis()}.wav")
        withContext(Dispatchers.IO) {
            FileOutputStream(tempFile).use { it.write(wavBytes) }
        }

        _state.update { it.copy(isPlaying = true) }

        try {
            suspendCancellableCoroutine { cont ->
                val player = MediaPlayer()
                mediaPlayer = player

                player.setDataSource(tempFile.absolutePath)
                player.prepare()
                player.setOnCompletionListener {
                    amplitudeJob?.cancel()
                    _state.update { it.copy(amplitude = 0f) }
                    player.release()
                    mediaPlayer = null
                    tempFile.delete()
                    if (cont.isActive) cont.resume(Unit) {}
                }
                player.setOnErrorListener { _, _, _ ->
                    amplitudeJob?.cancel()
                    player.release()
                    mediaPlayer = null
                    tempFile.delete()
                    if (cont.isActive) cont.resume(Unit) {}
                    true
                }

                // Start amplitude polling
                if (curve != null) {
                    amplitudeJob = scope.launch {
                        while (isActive) {
                            try {
                                val pos = player.currentPosition
                                val idx = (pos / curve.windowDurationMs).toInt()
                                val amp = if (idx in curve.values.indices) curve.values[idx] else 0f
                                _state.update { it.copy(amplitude = amp) }
                            } catch (_: Exception) { break }
                            delay(POLL_INTERVAL_MS)
                        }
                    }
                }

                player.start()

                cont.invokeOnCancellation {
                    amplitudeJob?.cancel()
                    try {
                        player.stop()
                        player.release()
                    } catch (_: Exception) {}
                    mediaPlayer = null
                    tempFile.delete()
                }
            }
        } catch (_: CancellationException) {
            // Cancelled — cleanup already done
        }
    }

    fun clearQueue() {
        queue.clear()
        amplitudeJob?.cancel()
        playbackJob?.cancel()
        mediaPlayer?.let {
            try {
                it.stop()
                it.release()
            } catch (_: Exception) {}
        }
        mediaPlayer = null
        isPlayingQueue = false
        _state.update { TtsState() }
    }

    fun release() {
        clearQueue()
        scope.cancel()
    }
}
