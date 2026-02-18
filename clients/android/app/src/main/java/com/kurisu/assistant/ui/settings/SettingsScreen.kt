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
import com.kurisu.assistant.domain.audio.AudioRecorder
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.ui.update.UpdateDialog

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onLogout: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    if (state.updateRelease != null) {
        UpdateDialog(
            release = state.updateRelease!!,
            progress = state.updateProgress,
            apkFile = state.updateApkFile,
            onDownload = viewModel::downloadAndInstall,
            onDismiss = viewModel::dismissUpdate,
        )
    }

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
                title = { Text("Settings") },
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
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Server section
            Text("Server", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = viewModel::setServerUrl,
                label = { Text("Backend URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = viewModel::saveServerUrl) {
                Text("Save URL")
            }

            HorizontalDivider()

            // Account section
            Text("Account", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = state.username,
                onValueChange = {},
                label = { Text("Username") },
                enabled = false,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.preferredName,
                onValueChange = viewModel::setPreferredName,
                label = { Text("Preferred Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.ollamaUrl,
                onValueChange = viewModel::setOllamaUrl,
                label = { Text("Ollama URL") },
                placeholder = { Text("http://localhost:11434") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = viewModel::saveProfile,
                enabled = !state.isSaving,
            ) {
                Text("Save Profile")
            }

            HorizontalDivider()

            // TTS section
            Text("Text-to-Speech", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = state.ttsBackend,
                onValueChange = viewModel::setTtsBackend,
                label = { Text("TTS Backend") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    if (state.backends.isNotEmpty()) {
                        Text("Available: ${state.backends.joinToString(", ")}")
                    }
                },
            )
            OutlinedTextField(
                value = state.ttsVoice,
                onValueChange = viewModel::setTtsVoice,
                label = { Text("Voice") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                supportingText = {
                    if (state.voices.isNotEmpty()) {
                        Text("Available: ${state.voices.take(5).joinToString(", ")}${if (state.voices.size > 5) "..." else ""}")
                    }
                },
            )
            Button(onClick = viewModel::saveTtsSettings) {
                Text("Save TTS Settings")
            }

            HorizontalDivider()

            // Microphone section
            Text("Microphone", style = MaterialTheme.typography.titleMedium)
            if (state.inputDevices.isNotEmpty()) {
                var micExpanded by remember { mutableStateOf(false) }
                val selectedName = if (state.selectedDeviceType < 0) {
                    "Default"
                } else {
                    state.inputDevices.find { it.first == state.selectedDeviceType }?.second
                        ?: AudioRecorder.deviceTypeName(state.selectedDeviceType)
                }
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
                            onClick = {
                                viewModel.selectMicDevice(-1)
                                micExpanded = false
                            },
                        )
                        state.inputDevices.forEach { (type, name) ->
                            DropdownMenuItem(
                                text = { Text(name) },
                                onClick = {
                                    viewModel.selectMicDevice(type)
                                    micExpanded = false
                                },
                            )
                        }
                    }
                }
            } else {
                Text(
                    "No input devices found",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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

            HorizontalDivider()

            // About & Logout
            Text("About", style = MaterialTheme.typography.titleMedium)
            Text("Version ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(
                onClick = viewModel::checkForUpdate,
                enabled = !state.isCheckingUpdate,
            ) {
                if (state.isCheckingUpdate) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text("Check for updates")
            }

            Spacer(Modifier.height(8.dp))

            var showLogoutDialog by remember { mutableStateOf(false) }
            Button(
                onClick = { showLogoutDialog = true },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Logout")
            }

            if (showLogoutDialog) {
                AlertDialog(
                    onDismissRequest = { showLogoutDialog = false },
                    title = { Text("Logout") },
                    text = { Text("Are you sure you want to logout?") },
                    confirmButton = {
                        TextButton(onClick = {
                            showLogoutDialog = false
                            viewModel.logout(onLogout)
                        }) { Text("Logout") }
                    },
                    dismissButton = {
                        TextButton(onClick = { showLogoutDialog = false }) { Text("Cancel") }
                    },
                )
            }
        }
    }
}
