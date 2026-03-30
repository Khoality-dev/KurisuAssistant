package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.domain.audio.AudioRecorder

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TtsAsrScreen(
    onBack: () -> Unit,
    viewModel: TtsAsrViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("TTS & ASR") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // TTS Backend
            Text("Text-to-Speech", style = MaterialTheme.typography.titleMedium)

            var backendExpanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(
                expanded = backendExpanded,
                onExpandedChange = { backendExpanded = it },
            ) {
                OutlinedTextField(
                    value = state.ttsBackend,
                    onValueChange = viewModel::setTtsBackend,
                    label = { Text("TTS Backend") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = backendExpanded) },
                )
                if (state.backends.isNotEmpty()) {
                    ExposedDropdownMenu(
                        expanded = backendExpanded,
                        onDismissRequest = { backendExpanded = false },
                    ) {
                        state.backends.forEach { backend ->
                            DropdownMenuItem(
                                text = { Text(backend) },
                                onClick = {
                                    viewModel.setTtsBackend(backend)
                                    backendExpanded = false
                                },
                            )
                        }
                    }
                }
            }

            // Auto-play toggle
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Generate TTS during responses", modifier = Modifier.weight(1f))
                Switch(checked = state.autoPlay, onCheckedChange = viewModel::setAutoPlay)
            }

            // Emotion controls (viXTTS only)
            if (state.ttsBackend.lowercase().contains("vixtts") || state.ttsBackend.lowercase().contains("gpt-sovits")) {
                HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
                Text("Emotion (viXTTS)", style = MaterialTheme.typography.titleSmall)

                Text("Emotion strength: ${"%.1f".format(state.emotionAlpha)}")
                Slider(
                    value = state.emotionAlpha,
                    onValueChange = viewModel::setEmotionAlpha,
                    valueRange = 0f..1f,
                    steps = 9,
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Infer emotion from text", modifier = Modifier.weight(1f))
                    Switch(checked = state.useEmotionText, onCheckedChange = viewModel::setUseEmotionText)
                }
            }

            // ASR
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Text("Speech Recognition", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = state.asrLanguage,
                onValueChange = viewModel::setAsrLanguage,
                label = { Text("Language") },
                placeholder = { Text("Auto-detect") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                supportingText = { Text("ISO 639-1 (en, ja, zh, vi). Empty = auto") },
            )

            // Microphone
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Text("Microphone", style = MaterialTheme.typography.titleMedium)

            if (state.inputDevices.isNotEmpty()) {
                var micExpanded by remember { mutableStateOf(false) }
                val selectedName = if (state.selectedDeviceType < 0) "Default"
                else state.inputDevices.find { it.first == state.selectedDeviceType }?.second
                    ?: AudioRecorder.deviceTypeName(state.selectedDeviceType)

                ExposedDropdownMenuBox(
                    expanded = micExpanded,
                    onExpandedChange = { micExpanded = it },
                ) {
                    OutlinedTextField(
                        value = selectedName,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Input Device") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = micExpanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor(),
                    )
                    ExposedDropdownMenu(
                        expanded = micExpanded,
                        onDismissRequest = { micExpanded = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("Default") },
                            onClick = { viewModel.selectMicDevice(-1); micExpanded = false },
                        )
                        state.inputDevices.forEach { (type, name) ->
                            DropdownMenuItem(
                                text = { Text(name) },
                                onClick = { viewModel.selectMicDevice(type); micExpanded = false },
                            )
                        }
                    }
                }
            }

            OutlinedButton(onClick = viewModel::testMicrophone) {
                Text(if (state.isTesting) "Stop Test" else "Test Microphone")
            }
            if (state.isTesting) {
                LinearProgressIndicator(
                    progress = { state.micTestLevel },
                    modifier = Modifier.fillMaxWidth().height(8.dp),
                )
            }
        }
    }
}
