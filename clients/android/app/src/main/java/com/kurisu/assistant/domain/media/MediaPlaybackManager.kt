package com.kurisu.assistant.domain.media

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.MediaChunkEvent
import com.kurisu.assistant.data.model.MediaErrorEvent
import com.kurisu.assistant.data.model.MediaStateEvent
import com.kurisu.assistant.data.model.MediaTrack
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

data class MediaPlayerState(
    val playbackState: String = "stopped", // "stopped" | "playing" | "paused"
    val currentTrack: MediaTrack? = null,
    val queue: List<MediaTrack> = emptyList(),
    val volume: Float = 1f,
    val isBuffering: Boolean = false,
    val error: String? = null,
)

@Singleton
class MediaPlaybackManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val wsManager: WebSocketManager,
    private val prefs: PreferencesDataStore,
) {
    companion object {
        private const val TAG = "MediaPlayback"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val _state = MutableStateFlow(MediaPlayerState())
    val state: StateFlow<MediaPlayerState> = _state.asStateFlow()

    // Chunk accumulation (module-level, not in state to avoid churn)
    private val chunks = mutableListOf<ByteArray>()
    private var chunkFormat: String = "webm"

    private var exoPlayer: ExoPlayer? = null
    private var tempFile: File? = null
    private var collectJob: Job? = null

    // Track the last known track title to detect track changes
    private var lastTrackTitle: String? = null

    // Guard: when user stops/skips locally, ignore in-flight chunks until next media_state
    private var stoppedLocally = false

    init {
        // Load persisted volume
        scope.launch {
            val vol = prefs.getMediaVolume()
            _state.value = _state.value.copy(volume = vol)
        }
    }

    fun startCollecting() {
        if (collectJob != null) return
        collectJob = scope.launch {
            wsManager.events.collect { event ->
                when (event) {
                    is MediaStateEvent -> handleMediaState(event)
                    is MediaChunkEvent -> handleMediaChunk(event)
                    is MediaErrorEvent -> handleMediaError(event)
                    else -> {} // ignore non-media events
                }
            }
        }
        Log.d(TAG, "Started collecting media events")
    }

    fun stopCollecting() {
        collectJob?.cancel()
        collectJob = null
        releasePlayer()
        Log.d(TAG, "Stopped collecting media events")
    }

    // ── Event handlers ───────────────────────────────────────────────

    private fun handleMediaState(event: MediaStateEvent) {
        Log.d(TAG, "media_state: state=${event.state} track=${event.currentTrack?.title}")

        // New playing state from backend = new track, clear local stop guard
        if (event.state == "playing") {
            stoppedLocally = false
        }

        val current = _state.value
        // Ignore backend "stopped" if we're still buffering/playing locally
        // (same logic as desktop client)
        if (event.state == "stopped" && (current.isBuffering || exoPlayer?.isPlaying == true)) {
            // Still update queue/track info but keep local playback state
            _state.value = current.copy(
                currentTrack = event.currentTrack ?: current.currentTrack,
                queue = event.queue,
            )
            return
        }

        // Clear chunks on track change
        val newTitle = event.currentTrack?.title
        if (newTitle != null && newTitle != lastTrackTitle) {
            chunks.clear()
            lastTrackTitle = newTitle
        }

        _state.value = current.copy(
            playbackState = if (event.state == "stopped" && exoPlayer?.isPlaying == true) current.playbackState else event.state,
            currentTrack = event.currentTrack ?: current.currentTrack,
            queue = event.queue,
        )
    }

    private fun handleMediaChunk(event: MediaChunkEvent) {
        if (stoppedLocally) return

        val decoded = Base64.decode(event.data, Base64.DEFAULT)
        chunks.add(decoded)
        chunkFormat = event.format

        if (event.chunkIndex == 0) {
            Log.d(TAG, "chunk #0 received, buffering...")
            _state.value = _state.value.copy(isBuffering = true)
        }

        if (event.chunkIndex % 50 == 0 && event.chunkIndex > 0) {
            Log.d(TAG, "chunk #${event.chunkIndex} received")
        }

        if (event.isLast) {
            val totalSize = chunks.sumOf { it.size }
            Log.d(TAG, "is_last chunk #${event.chunkIndex}, total ${chunks.size} chunks, ${totalSize} bytes")
            scope.launch { playBuffer() }
        }
    }

    private fun handleMediaError(event: MediaErrorEvent) {
        Log.e(TAG, "media_error: ${event.error}")
        _state.value = _state.value.copy(error = event.error, isBuffering = false)
    }

    // ── Playback ─────────────────────────────────────────────────────

    private suspend fun playBuffer() {
        if (chunks.isEmpty()) return

        // Concatenate all chunks into a single byte array
        val totalSize = chunks.sumOf { it.size }
        val buffer = ByteArray(totalSize)
        var offset = 0
        for (chunk in chunks) {
            chunk.copyInto(buffer, offset)
            offset += chunk.size
        }
        chunks.clear()

        // Determine file extension from format
        val extension = when (chunkFormat) {
            "opus", "webm" -> ".webm"
            "m4a", "mp4" -> ".m4a"
            "mp3" -> ".mp3"
            else -> ".${chunkFormat}"
        }

        // Release previous player
        releasePlayer()

        // Write to temp file
        val audioFile = withContext(Dispatchers.IO) {
            File.createTempFile("kurisu_media_", extension, context.cacheDir).apply {
                writeBytes(buffer)
            }
        }
        tempFile = audioFile

        Log.d(TAG, "Playing buffer: ${totalSize} bytes as $extension")

        // Create and play with ExoPlayer
        val player = ExoPlayer.Builder(context).build()
        player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(audioFile)))
        player.volume = _state.value.volume
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_ENDED -> {
                        Log.d(TAG, "Playback ended")
                        scope.launch {
                            releasePlayer()
                            // Only set stopped if there's no next track queued
                            if (_state.value.queue.isEmpty()) {
                                _state.value = _state.value.copy(
                                    playbackState = "stopped",
                                    isBuffering = false,
                                    currentTrack = null,
                                )
                            }
                        }
                    }
                    Player.STATE_READY -> {
                        _state.value = _state.value.copy(
                            playbackState = "playing",
                            isBuffering = false,
                        )
                    }
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                Log.e(TAG, "ExoPlayer error: ${error.message}")
                _state.value = _state.value.copy(
                    error = error.message,
                    isBuffering = false,
                )
            }
        })
        player.prepare()
        player.playWhenReady = true
        exoPlayer = player
    }

    private fun releasePlayer() {
        exoPlayer?.let {
            it.stop()
            it.release()
        }
        exoPlayer = null
        tempFile?.delete()
        tempFile = null
    }

    // ── Controls ─────────────────────────────────────────────────────

    fun togglePlayPause() {
        val player = exoPlayer ?: return
        if (player.isPlaying) {
            player.playWhenReady = false
            _state.value = _state.value.copy(playbackState = "paused")
            wsManager.sendMediaPause()
        } else {
            player.playWhenReady = true
            _state.value = _state.value.copy(playbackState = "playing")
            wsManager.sendMediaResume()
        }
    }

    fun skip() {
        stoppedLocally = true
        chunks.clear()
        releasePlayer()
        _state.value = _state.value.copy(isBuffering = false)
        wsManager.sendMediaSkip()
    }

    fun stop() {
        stoppedLocally = true
        chunks.clear()
        releasePlayer()
        _state.value = _state.value.copy(
            playbackState = "stopped",
            isBuffering = false,
            currentTrack = null,
            queue = emptyList(),
        )
        wsManager.sendMediaStop()
    }

    fun setVolume(volume: Float) {
        val clamped = volume.coerceIn(0f, 1f)
        exoPlayer?.volume = clamped
        _state.value = _state.value.copy(volume = clamped)
        scope.launch { prefs.setMediaVolume(clamped) }
        wsManager.sendMediaVolume(clamped)
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null)
    }
}
