package com.kurisu.assistant.ui.character

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

/**
 * The live character, as a sheet over the transcript.
 *
 * It is not a destination: navigating away would tear down the chat while it is
 * streaming, and the whole point of the character is to watch it answer. So it
 * is hosted inside the chat screen, dismissed by swiping the sheet down or
 * tapping the scrim, and the conversation keeps running underneath the whole
 * time.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharacterSheet(
    personaId: Int?,
    onDismiss: () -> Unit,
    viewModel: CharacterViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    // Bind to whoever is answering this conversation. The character used to be
    // read off a nav argument the route never carried.
    LaunchedEffect(personaId) { viewModel.bindPersona(personaId) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Color.Black,
        contentColor = Color.White,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(360.dp)
                    .background(Color.Black, MaterialTheme.shapes.large),
            ) {
                when {
                    state.isLoaded -> {
                        CharacterCanvas(
                            compositor = viewModel.compositor,
                            modifier = Modifier.fillMaxSize(),
                        )

                        if (state.isTransitioningVideo && state.transitionVideoUrl != null) {
                            TransitionVideoPlayer(
                                videoUrl = state.transitionVideoUrl,
                                playbackRate = state.transitionPlaybackRate,
                                onVideoEnded = viewModel::onTransitionVideoEnded,
                                onFadeOutComplete = viewModel::onTransitionVideoFadeOutComplete,
                                modifier = Modifier.fillMaxSize(),
                                authToken = state.authToken,
                            )
                        }

                        state.subtitle?.let { subtitle ->
                            Surface(
                                color = Color.Black.copy(alpha = 0.7f),
                                contentColor = Color.White,
                                shape = MaterialTheme.shapes.medium,
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .padding(16.dp)
                                    .widthIn(max = 400.dp),
                            ) {
                                Text(
                                    text = subtitle,
                                    style = MaterialTheme.typography.bodyLarge,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }

                    state.error != null -> {
                        Text(
                            text = state.error.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = Color.White.copy(alpha = 0.7f),
                            textAlign = TextAlign.Center,
                            modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        )
                    }

                    else -> {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            modifier = Modifier.align(Alignment.Center),
                        ) {
                            CircularProgressIndicator(color = Color.White)
                            Text(
                                text = "Loading character…",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Color.White.copy(alpha = 0.7f),
                            )
                        }
                    }
                }
            }

            Text(
                text = "The chat keeps streaming behind this. Swipe down to go back to the transcript.",
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.65f),
            )
        }
    }
}
