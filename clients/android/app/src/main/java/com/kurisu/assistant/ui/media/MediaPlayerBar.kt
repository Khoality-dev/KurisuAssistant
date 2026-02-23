package com.kurisu.assistant.ui.media

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import coil.compose.AsyncImage
import com.kurisu.assistant.domain.media.MediaPlaybackManager
import com.kurisu.assistant.domain.media.MediaPlayerState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

@HiltViewModel
class MediaPlayerViewModel @Inject constructor(
    private val mediaPlaybackManager: MediaPlaybackManager,
) : ViewModel() {

    val state: StateFlow<MediaPlayerState> = mediaPlaybackManager.state

    fun togglePlayPause() = mediaPlaybackManager.togglePlayPause()
    fun skip() = mediaPlaybackManager.skip()
    fun stop() = mediaPlaybackManager.stop()
    fun setVolume(volume: Float) = mediaPlaybackManager.setVolume(volume)
}

@Composable
fun MediaPlayerBar(
    viewModel: MediaPlayerViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val isVisible = state.playbackState != "stopped" || state.isBuffering

    AnimatedVisibility(
        visible = isVisible,
        enter = slideInVertically(initialOffsetY = { it }),
        exit = slideOutVertically(targetOffsetY = { it }),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            tonalElevation = 3.dp,
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Thumbnail
                val thumbnail = state.currentTrack?.thumbnail
                if (thumbnail != null) {
                    AsyncImage(
                        model = thumbnail,
                        contentDescription = "Track thumbnail",
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(6.dp)),
                        contentScale = ContentScale.Crop,
                    )
                } else {
                    Surface(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(6.dp)),
                        color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Icon(
                            imageVector = Icons.Default.MusicNote,
                            contentDescription = null,
                            modifier = Modifier.padding(12.dp),
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                }

                Spacer(Modifier.width(12.dp))

                // Title + Artist
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = state.currentTrack?.title ?: if (state.isBuffering) "Buffering..." else "",
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val artist = state.currentTrack?.artist
                    if (artist != null) {
                        Text(
                            text = artist,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                // Play/Pause button (with buffering overlay)
                if (state.isBuffering && state.playbackState != "playing") {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    IconButton(onClick = { viewModel.togglePlayPause() }) {
                        Icon(
                            imageVector = if (state.playbackState == "playing") Icons.Default.Pause else Icons.Default.PlayArrow,
                            contentDescription = if (state.playbackState == "playing") "Pause" else "Play",
                        )
                    }
                }

                // Skip
                IconButton(onClick = { viewModel.skip() }) {
                    Icon(
                        imageVector = Icons.Default.SkipNext,
                        contentDescription = "Skip",
                    )
                }

                // Stop
                IconButton(onClick = { viewModel.stop() }) {
                    Icon(
                        imageVector = Icons.Default.Stop,
                        contentDescription = "Stop",
                    )
                }
            }
        }
    }
}
