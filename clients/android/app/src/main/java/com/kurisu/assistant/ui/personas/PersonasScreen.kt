package com.kurisu.assistant.ui.personas

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.SubcomposeAsyncImage
import coil.compose.SubcomposeAsyncImageContent
import com.kurisu.assistant.data.model.Persona

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonasScreen(
    onBack: () -> Unit,
    viewModel: PersonasViewModel = hiltViewModel(),
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
                title = { Text("Personas") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::loadAll) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            FloatingActionButton(onClick = viewModel::openNewEditor) {
                Icon(Icons.Default.Add, contentDescription = "New Persona")
            }
        },
    ) { padding ->
        if (state.isLoading && state.personas.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        } else if (state.personas.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "No personas yet",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Personas define identity, voice, and personality",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = viewModel::openNewEditor) {
                        Text("Create your first persona")
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.personas, key = { it.id }) { persona ->
                    PersonaCard(
                        persona = persona,
                        baseUrl = state.baseUrl,
                        onEdit = { viewModel.openEditEditor(persona) },
                        onDelete = { viewModel.confirmDelete(persona) },
                    )
                }
            }
        }
    }

    // Editor dialog
    if (state.showEditor) {
        PersonaEditorDialog(
            isEditing = state.editingPersona != null,
            avatarUrl = state.editingPersona?.avatarUuid?.let {
                "${state.baseUrl.trimEnd('/')}/images/$it"
            },
            name = state.editorName,
            systemPrompt = state.editorSystemPrompt,
            preferredName = state.editorPreferredName,
            triggerWord = state.editorTriggerWord,
            isSaving = state.isSaving,
            onNameChange = viewModel::setEditorName,
            onSystemPromptChange = viewModel::setEditorSystemPrompt,
            onPreferredNameChange = viewModel::setEditorPreferredName,
            onTriggerWordChange = viewModel::setEditorTriggerWord,
            onSave = viewModel::savePersona,
            onDismiss = viewModel::dismissEditor,
        )
    }

    // Delete confirmation
    state.deletingPersona?.let { persona ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDelete,
            title = { Text("Delete Persona") },
            text = { Text("Delete \"${persona.name}\"? This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = viewModel::deletePersona) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDelete) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun PersonaCard(
    persona: Persona,
    baseUrl: String,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        onClick = onEdit,
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Avatar
            PersonaAvatar(
                name = persona.name,
                avatarUrl = persona.avatarUuid?.let { "${baseUrl.trimEnd('/')}/images/$it" },
                size = 48,
            )

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = persona.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (persona.preferredName != null) {
                    Text(
                        text = persona.preferredName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // Tags
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (persona.voiceReference != null) {
                        SuggestionChip(
                            onClick = {},
                            icon = { Icon(Icons.Default.Mic, contentDescription = null, modifier = Modifier.size(14.dp)) },
                            label = { Text(persona.voiceReference, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                    if (persona.triggerWord != null) {
                        SuggestionChip(
                            onClick = {},
                            label = { Text(persona.triggerWord, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                }
            }

            IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "Delete",
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun PersonaEditorDialog(
    isEditing: Boolean,
    avatarUrl: String?,
    name: String,
    systemPrompt: String,
    preferredName: String,
    triggerWord: String,
    isSaving: Boolean,
    onNameChange: (String) -> Unit,
    onSystemPromptChange: (String) -> Unit,
    onPreferredNameChange: (String) -> Unit,
    onTriggerWordChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isEditing) "Edit Persona" else "New Persona") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (isEditing) {
                    Box(
                        modifier = Modifier.fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        PersonaAvatar(name = name, avatarUrl = avatarUrl, size = 72)
                    }
                }

                OutlinedTextField(
                    value = name,
                    onValueChange = onNameChange,
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value = preferredName,
                    onValueChange = onPreferredNameChange,
                    label = { Text("Preferred Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Display name in conversations") },
                )

                OutlinedTextField(
                    value = triggerWord,
                    onValueChange = onTriggerWordChange,
                    label = { Text("Trigger Word") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Voice activation keyword") },
                )

                OutlinedTextField(
                    value = systemPrompt,
                    onValueChange = onSystemPromptChange,
                    label = { Text("Personality") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    maxLines = 8,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = !isSaving) {
                Text(if (isEditing) "Save" else "Create")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun PersonaAvatar(name: String, avatarUrl: String?, size: Int) {
    if (avatarUrl != null) {
        SubcomposeAsyncImage(
            model = avatarUrl,
            contentDescription = name,
            modifier = Modifier.size(size.dp).clip(CircleShape),
            contentScale = ContentScale.Crop,
            loading = { AvatarFallback(name, size) },
            error = { AvatarFallback(name, size) },
            success = { SubcomposeAsyncImageContent() },
        )
    } else {
        AvatarFallback(name, size)
    }
}

@Composable
private fun AvatarFallback(name: String, size: Int) {
    Surface(
        modifier = Modifier.size(size.dp),
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = name.take(2).uppercase(),
                style = if (size >= 72) MaterialTheme.typography.headlineSmall
                else MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}
