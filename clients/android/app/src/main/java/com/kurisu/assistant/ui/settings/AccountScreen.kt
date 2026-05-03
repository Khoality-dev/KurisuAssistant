package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(
    onBack: () -> Unit,
    viewModel: AccountViewModel = hiltViewModel(),
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
                title = { Text("Account") },
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
            // Server
            Text("Server", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = viewModel::setServerUrl,
                label = { Text("Backend URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )
            Button(onClick = viewModel::saveServerUrl) { Text("Save URL") }

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

            // Ollama
            Text("Ollama", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = state.ollamaUrl,
                onValueChange = viewModel::setOllamaUrl,
                label = { Text("Ollama Server URL") },
                placeholder = { Text("http://localhost:11434") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            // API Keys
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Text("API Keys", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = state.geminiApiKey,
                onValueChange = viewModel::setGeminiApiKey,
                label = { Text("Google Gemini API Key") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
            )
            OutlinedButton(
                onClick = viewModel::validateGeminiKey,
                enabled = !state.isValidatingGemini && state.geminiApiKey.isNotBlank(),
            ) {
                if (state.isValidatingGemini) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text("Validate Gemini Key")
            }

            OutlinedTextField(
                value = state.nvidiaApiKey,
                onValueChange = viewModel::setNvidiaApiKey,
                label = { Text("NVIDIA NIM API Key") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
            )
            OutlinedButton(
                onClick = viewModel::validateNvidiaKey,
                enabled = !state.isValidatingNvidia && state.nvidiaApiKey.isNotBlank(),
            ) {
                if (state.isValidatingNvidia) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text("Validate NVIDIA Key")
            }

            // Model settings
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Text("Model", style = MaterialTheme.typography.titleMedium)

            var modelExpanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(
                expanded = modelExpanded,
                onExpandedChange = { modelExpanded = it },
            ) {
                OutlinedTextField(
                    value = state.summaryModel,
                    onValueChange = viewModel::setSummaryModel,
                    label = { Text("Summary Model") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelExpanded) },
                    supportingText = { Text("For session summaries & memory consolidation") },
                )
                if (state.availableModels.isNotEmpty()) {
                    ExposedDropdownMenu(
                        expanded = modelExpanded,
                        onDismissRequest = { modelExpanded = false },
                    ) {
                        val grouped = state.availableModels.groupBy { it.provider }
                            .toSortedMap()
                        grouped.forEach { (provider, models) ->
                            DropdownMenuItem(
                                enabled = false,
                                text = {
                                    Text(
                                        provider.uppercase(),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                },
                                onClick = {},
                            )
                            models.sortedBy { it.name }.forEach { model ->
                                DropdownMenuItem(
                                    text = { Text(model.name) },
                                    onClick = {
                                        viewModel.setSummaryModel(model.name)
                                        modelExpanded = false
                                    },
                                )
                            }
                        }
                    }
                }
            }

            OutlinedTextField(
                value = state.contextSize,
                onValueChange = viewModel::setContextSize,
                label = { Text("Context Size") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                supportingText = { Text("Ollama num_ctx (2048-131072, default 8192)") },
            )

            Button(
                onClick = viewModel::saveProfile,
                enabled = !state.isSaving,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Save") }
        }
    }
}
