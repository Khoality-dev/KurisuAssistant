package com.kurisu.assistant.ui.character

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CharacterScreen(
    onBack: () -> Unit,
    viewModel: CharacterViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Character") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.White,
                ),
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(Color.White),
        ) {
            if (state.isLoaded) {
                // Character canvas
                CharacterCanvas(
                    compositor = viewModel.compositor,
                    modifier = Modifier.fillMaxSize(),
                )

                // Transition video overlay
                if (state.isTransitioningVideo && state.transitionVideoUrl != null) {
                    TransitionVideoPlayer(
                        videoUrl = state.transitionVideoUrl,
                        playbackRate = state.transitionPlaybackRate,
                        onVideoEnded = viewModel::onTransitionVideoEnded,
                        onFadeOutComplete = viewModel::onTransitionVideoFadeOutComplete,
                        modifier = Modifier.fillMaxSize(),
                    )
                }

                // Subtitle overlay
                state.subtitle?.let { subtitle ->
                    Surface(
                        color = Color.Black.copy(alpha = 0.7f),
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(16.dp)
                            .widthIn(max = 400.dp),
                    ) {
                        Text(
                            text = subtitle,
                            color = Color.White,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }
                }
            } else {
                // Loading state
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(16.dp))
                        Text("Loading character...")
                    }
                }
            }
        }
    }
}
