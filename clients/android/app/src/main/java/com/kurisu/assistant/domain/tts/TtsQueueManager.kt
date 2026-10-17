package com.kurisu.assistant.domain.tts

import android.content.Context
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.repository.TtsRepository
import com.kurisu.assistant.domain.chat.stripNarration
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlin.coroutines.resume
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
    /**
     * The sentence playing now, for the 3D character page (#246): set once
     * `MediaPlayer.start()` has returned, kept across sentences, and dropped
     * once when the queue drains — the page's cue to let the feeling go.
     */
    val currentSegment: SpeechSegment? = null,
    /** The player's own position, every [SPEECH_SYNC_INTERVAL_MS] while a sentence plays. */
    val speechSync: SpeechSync? = null,
)

private data class TtsQueueItem(
    val audioDeferred: Deferred<ByteArray>,
    val text: String,
    /** Feelings inside this sentence, as fractions of the way through it (#244). */
    val cues: List<SegmentCue>,
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

    /**
     * A sentence that could not be synthesized or played, as one line for the
     * user. Wired by `CoreService`, which owns every callback in this layer;
     * before it existed a dead speech service was a log line and silence (#200).
     */
    var onError: ((String) -> Unit)? = null

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

    fun queueText(text: String, voice: String? = null, cues: List<SegmentCue> = emptyList()) {
        val trimmed = stripNarration(text.trim())
        if (trimmed.isBlank()) return

        val audioDeferred = scope.async {
            // Null names no provider, so the server's default model answers.
            val backend = resolveTtsBackend(prefs.getTTSBackend())
            ttsRepository.synthesize(trimmed, voice, backend = backend)
        }
        queue.add(TtsQueueItem(audioDeferred, trimmed, cues))
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
                    playWavBytes(wavBytes, item)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.e(TAG, "TTS playback error: ${e.message}")
                    onError?.invoke(describeSpeechFailure("Speech", e))
                }
            }
            _state.update {
                it.copy(isPlaying = false, isQueueActive = false, amplitude = 0f, currentText = null, currentSegment = null, speechSync = null)
            }
            isPlayingQueue = false
        }
    }

    private suspend fun playWavBytes(wavBytes: ByteArray, item: TtsQueueItem) {
        // Pre-compute amplitude curve for lip sync
        val parsed = parseWavPcm(wavBytes)
        val curve = if (parsed != null) computeRMSCurve(parsed.samples, parsed.sampleRate) else null

        // Write to temp file
        val tempFile = File(context.cacheDir, "tts_${System.currentTimeMillis()}.wav")
        withContext(Dispatchers.IO) {
            FileOutputStream(tempFile).use { it.write(wavBytes) }
        }

        // Resolve preferred output device once per playback (prefs is suspend; lookup is cheap)
        val preferredDeviceId = prefs.getSpeakerDeviceId()

        _state.update { it.copy(isPlaying = true) }

        try {
            suspendCancellableCoroutine { cont ->
                val player = MediaPlayer()
                mediaPlayer = player

                player.setDataSource(tempFile.absolutePath)
                applyPreferredOutput(player, preferredDeviceId)
                player.prepare()
                player.setOnCompletionListener {
                    amplitudeJob?.cancel()
                    _state.update { it.copy(amplitude = 0f) }
                    player.release()
                    mediaPlayer = null
                    tempFile.delete()
                    if (cont.isActive) cont.resume(Unit)
                }
                player.setOnErrorListener { _, _, _ ->
                    amplitudeJob?.cancel()
                    player.release()
                    mediaPlayer = null
                    tempFile.delete()
                    if (cont.isActive) cont.resume(Unit)
                    true
                }

                player.start()
                // Stamped after start() returned, never before: the page clocks the
                // mouth from this moment, and prepare() can take a while (#246).
                val segment = speechSegmentOf(item.text, System.currentTimeMillis(), player.duration.toLong(), curve, item.cues)
                _state.update { it.copy(currentSegment = segment, speechSync = null) }

                // Poll the player: the 2D mouth's amplitude every frame-ish, and the
                // position for the 3D page twice a second.
                amplitudeJob = scope.launch {
                    var sinceSync = 0L
                    while (isActive) {
                        try {
                            val pos = player.currentPosition
                            if (curve != null) {
                                val idx = (pos / curve.windowDurationMs).toInt()
                                val amp = if (idx in curve.values.indices) curve.values[idx] else 0f
                                _state.update { it.copy(amplitude = amp) }
                            }
                            sinceSync += POLL_INTERVAL_MS
                            if (sinceSync >= SPEECH_SYNC_INTERVAL_MS) {
                                sinceSync = 0
                                val sync = SpeechSync(pos.toLong(), System.currentTimeMillis())
                                _state.update { it.copy(speechSync = sync) }
                            }
                        } catch (_: Exception) { break }
                        delay(POLL_INTERVAL_MS)
                    }
                }

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

    /**
     * Route TTS playback to the user-selected output device. The id is the AudioDeviceInfo.id
     * (as a string) persisted by the Speaker setting; empty means system default.
     */
    private fun applyPreferredOutput(player: MediaPlayer, deviceId: String) {
        if (deviceId.isBlank()) return
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            val device = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .firstOrNull { it.id.toString() == deviceId }
            if (device != null) {
                player.preferredDevice = device
            } else {
                Log.w(TAG, "Preferred TTS output device id=$deviceId not found; using system default")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to apply preferred TTS output: ${e.message}")
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
