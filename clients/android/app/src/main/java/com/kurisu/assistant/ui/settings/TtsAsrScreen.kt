package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
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

            // ASR Mode
            var modeExpanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(
                expanded = modeExpanded,
                onExpandedChange = { modeExpanded = it },
            ) {
                OutlinedTextField(
                    value = if (state.asrMode == "routing") "Routing (per-language)" else "Fixed (single model)",
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("ASR Mode") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modeExpanded) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                )
                ExposedDropdownMenu(expanded = modeExpanded, onDismissRequest = { modeExpanded = false }) {
                    DropdownMenuItem(text = { Text("Fixed (single model)") }, onClick = { viewModel.setAsrMode("fixed"); modeExpanded = false })
                    DropdownMenuItem(text = { Text("Routing (per-language)") }, onClick = { viewModel.setAsrMode("routing"); modeExpanded = false })
                }
            }

            // Fixed-model picker
            if (state.asrMode == "fixed") {
                var fixedExpanded by remember { mutableStateOf(false) }
                val display = if (state.asrFixedModel.isBlank()) "Server default"
                else state.asrModels.firstOrNull { it.id == state.asrFixedModel }?.name ?: state.asrFixedModel
                ExposedDropdownMenuBox(
                    expanded = fixedExpanded,
                    onExpandedChange = { fixedExpanded = it },
                ) {
                    OutlinedTextField(
                        value = display,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Fixed Model") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = fixedExpanded) },
                        modifier = Modifier.fillMaxWidth().menuAnchor(),
                    )
                    ExposedDropdownMenu(expanded = fixedExpanded, onDismissRequest = { fixedExpanded = false }) {
                        DropdownMenuItem(
                            text = { Text("Server default") },
                            onClick = { viewModel.setAsrFixedModel(""); fixedExpanded = false },
                        )
                        state.asrModels.forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model.name) },
                                onClick = { viewModel.setAsrFixedModel(model.id); fixedExpanded = false },
                            )
                        }
                    }
                }
            }

            // Routing-mode mapping table
            if (state.asrMode == "routing") {
                Text(
                    "Language → Model mapping",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
                state.asrModelMap.forEachIndexed { index, entry ->
                    AsrMappingRow(
                        entry = entry,
                        models = state.asrModels,
                        onLanguageChange = { v -> viewModel.updateAsrMapping(index, language = v) },
                        onModelChange = { v -> viewModel.updateAsrMapping(index, model = v) },
                        onDelete = { viewModel.deleteAsrMapping(index) },
                    )
                }
                OutlinedButton(
                    onClick = viewModel::addAsrMapping,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Add mapping")
                }
            }

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

            // Speaker / output device
            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Text("Speaker", style = MaterialTheme.typography.titleMedium)
            var speakerExpanded by remember { mutableStateOf(false) }
            val speakerName = if (state.selectedSpeakerId.isBlank()) "System default"
            else state.outputDevices.firstOrNull { it.first == state.selectedSpeakerId }?.second
                ?: state.selectedSpeakerId
            ExposedDropdownMenuBox(
                expanded = speakerExpanded,
                onExpandedChange = { speakerExpanded = it },
            ) {
                OutlinedTextField(
                    value = speakerName,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Output Device") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = speakerExpanded) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                )
                ExposedDropdownMenu(expanded = speakerExpanded, onDismissRequest = { speakerExpanded = false }) {
                    DropdownMenuItem(
                        text = { Text("System default") },
                        onClick = { viewModel.selectSpeakerDevice(""); speakerExpanded = false },
                    )
                    state.outputDevices.forEach { (id, name) ->
                        DropdownMenuItem(
                            text = { Text(name) },
                            onClick = { viewModel.selectSpeakerDevice(id); speakerExpanded = false },
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AsrMappingRow(
    entry: com.kurisu.assistant.data.model.AsrLanguageModelEntry,
    models: List<com.kurisu.assistant.data.model.AsrModelInfo>,
    onLanguageChange: (String) -> Unit,
    onModelChange: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val commonLanguages = listOf("en", "vi", "ja", "zh", "ko", "fr", "de", "es", "ru", "pt", "th", "ar")

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Language picker
        var langExpanded by remember { mutableStateOf(false) }
        ExposedDropdownMenuBox(
            expanded = langExpanded,
            onExpandedChange = { langExpanded = it },
            modifier = Modifier.weight(1f),
        ) {
            OutlinedTextField(
                value = entry.language,
                onValueChange = onLanguageChange,
                label = { Text("Lang") },
                singleLine = true,
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = langExpanded) },
                modifier = Modifier.menuAnchor().fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = langExpanded, onDismissRequest = { langExpanded = false }) {
                commonLanguages.forEach { lang ->
                    DropdownMenuItem(
                        text = { Text(lang) },
                        onClick = { onLanguageChange(lang); langExpanded = false },
                    )
                }
            }
        }

        // Model picker
        var modelExpanded by remember { mutableStateOf(false) }
        val display = models.firstOrNull { it.id == entry.model }?.name ?: entry.model.ifBlank { "(none)" }
        ExposedDropdownMenuBox(
            expanded = modelExpanded,
            onExpandedChange = { modelExpanded = it },
            modifier = Modifier.weight(2f),
        ) {
            OutlinedTextField(
                value = display,
                onValueChange = {},
                readOnly = true,
                label = { Text("Model") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelExpanded) },
                modifier = Modifier.menuAnchor().fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = modelExpanded, onDismissRequest = { modelExpanded = false }) {
                models.forEach { model ->
                    DropdownMenuItem(
                        text = { Text(model.name) },
                        onClick = { onModelChange(model.id); modelExpanded = false },
                    )
                }
            }
        }

        IconButton(onClick = onDelete) {
            Icon(Icons.Default.Delete, contentDescription = "Remove", tint = MaterialTheme.colorScheme.error)
        }
    }
}
