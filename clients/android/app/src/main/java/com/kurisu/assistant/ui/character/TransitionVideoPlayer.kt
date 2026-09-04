package com.kurisu.assistant.ui.character

import androidx.annotation.OptIn
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.kurisu.assistant.data.local.EncryptedPreferences

@OptIn(UnstableApi::class)
@Composable
fun TransitionVideoPlayer(
    videoUrl: String?,
    playbackRate: Float = 1f,
    onVideoEnded: () -> Unit,
    onFadeOutComplete: () -> Unit,
    modifier: Modifier = Modifier,
    authToken: String? = null,
) {
    val context = androidx.compose.ui.platform.LocalContext.current

    if (videoUrl == null) return

    // Start invisible — fade in once first frame renders, fade out when video ends
    val alphaAnim = remember { Animatable(0f) }
    var firstFrameRendered by remember { mutableStateOf(false) }
    var videoEnded by remember { mutableStateOf(false) }

    // Character assets are served from an authenticated endpoint, so the player
    // needs the bearer token on its own requests; ExoPlayer does not share the
    // app's OkHttp interceptor chain.
    val exoPlayer = remember(videoUrl, authToken) {
        val dataSourceFactory = DefaultHttpDataSource.Factory().apply {
            if (authToken != null) {
                setDefaultRequestProperties(mapOf("Authorization" to "Bearer $authToken"))
            }
        }
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build().apply {
            setMediaItem(MediaItem.fromUri(videoUrl))
            playbackParameters = PlaybackParameters(playbackRate)
            repeatMode = Player.REPEAT_MODE_OFF
            prepare()
            playWhenReady = true
        }
    }

    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() {
                firstFrameRendered = true
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    videoEnded = true
                }
            }
        }
        exoPlayer.addListener(listener)

        onDispose {
            exoPlayer.removeListener(listener)
            exoPlayer.release()
        }
    }

    // Fade in once first video frame is rendered
    LaunchedEffect(firstFrameRendered) {
        if (firstFrameRendered) {
            alphaAnim.animateTo(1f, animationSpec = tween(durationMillis = 100))
        }
    }

    // When video ends: switch pose underneath, then fade out over 150ms
    LaunchedEffect(videoEnded) {
        if (videoEnded) {
            onVideoEnded()
            alphaAnim.animateTo(0f, animationSpec = tween(durationMillis = 150))
            onFadeOutComplete()
        }
    }

    AndroidView(
        factory = {
            PlayerView(it).apply {
                player = exoPlayer
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
        },
        modifier = modifier.alpha(alphaAnim.value),
    )
}
