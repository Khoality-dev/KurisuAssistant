package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onLogout: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
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

            // About & Logout
            Text("About", style = MaterialTheme.typography.titleMedium)
            Text("Version 0.1.0", style = MaterialTheme.typography.bodyMedium)

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
