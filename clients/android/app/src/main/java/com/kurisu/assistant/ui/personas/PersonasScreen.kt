package com.kurisu.assistant.ui.personas

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.ui.theme.KurisuTheme
import java.io.File

/**
 * The personas: who the one assistant sounds like.
 *
 * Tapping a row makes it the default for new chats — the design's whole
 * interaction model for this screen — and the pencil opens the editor. There is
 * no picker on new-chat: a new conversation silently adopts the default, and a
 * single conversation overrides it from the chat header.
 *
 * @param onPreviewCharacter opens the character canvas for a persona, when the
 *   nav graph has somewhere to send it. Left null, the editor's character row is
 *   a plain read-only status rather than a chevron that goes nowhere.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonasScreen(
    onBack: () -> Unit,
    onPreviewCharacter: ((personaId: Int) -> Unit)? = null,
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
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::load, enabled = !state.isLoading) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = viewModel::openNewPersona,
                icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                text = { Text("New persona") },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Column(
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(
                    "A persona swaps the assistant's voice, name and system prompt. The model, tools and memory stay the same.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "Tap one to make it the default for new chats. A single conversation can override it from the chat header.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            when {
                state.isLoading && state.personas.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }

                state.loadError != null && state.personas.isEmpty() ->
                    Box(
                        Modifier.fillMaxSize().padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                state.loadError!!,
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = viewModel::load) { Text("Try again") }
                        }
                    }

                state.personas.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                "No personas yet",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(8.dp))
                            Button(onClick = viewModel::openNewPersona) {
                                Text("Create your first persona")
                            }
                        }
                    }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 96.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.personas, key = { it.id }) { persona ->
                        PersonaRow(
                            persona = persona,
                            avatarUrl = viewModel.avatarUrl(persona.avatarUuid),
                            isDefault = persona.id == state.defaultPersonaId,
                            // The design only flags this when it differs from the
                            // default; saying "answering the open chat" on the
                            // default row would be noise on every row.
                            isAnsweringOpenChat = persona.id == state.openChatPersonaId &&
                                persona.id != state.defaultPersonaId,
                            onMakeDefault = { viewModel.makeDefault(persona) },
                            onEdit = { viewModel.openPersona(persona) },
                        )
                    }
                }
            }
        }
    }

    state.draft?.let { draft ->
        PersonaEditor(
            draft = draft,
            avatarUrl = viewModel.avatarUrl(draft.avatarUuid),
            availableVoices = state.availableVoices,
            isSaving = state.isSaving,
            isUploadingAvatar = state.isUploadingAvatar,
            onPickAvatar = viewModel::uploadAvatar,
            onNameChange = viewModel::setDraftName,
            onDescriptionChange = viewModel::setDraftDescription,
            onPreferredNameChange = viewModel::setDraftPreferredName,
            onVoiceChange = viewModel::setDraftVoiceReference,
            onPreviewVoice = viewModel::previewVoice,
            onSystemPromptChange = viewModel::setDraftSystemPrompt,
            onEnabledChange = viewModel::setDraftEnabled,
            onPreviewCharacter = onPreviewCharacter,
            onDelete = {
                state.personas.firstOrNull { it.id == draft.id }?.let(viewModel::confirmDelete)
            },
            onSave = viewModel::savePersona,
            onCancel = viewModel::dismissEditor,
        )
    }

    state.deleting?.let { persona ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDelete,
            title = { Text("Delete persona") },
            text = {
                Text(
                    "Delete \"${persona.name}\"? Conversations it answered keep its name on those " +
                        "messages. The assistant keeps its memory."
                )
            },
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
private fun PersonaRow(
    persona: Persona,
    avatarUrl: String?,
    isDefault: Boolean,
    isAnsweringOpenChat: Boolean,
    onMakeDefault: () -> Unit,
    onEdit: () -> Unit,
) {
    OutlinedCard(
        modifier = Modifier.fillMaxWidth(),
        onClick = onMakeDefault,
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.Top,
        ) {
            PersonaAvatar(name = persona.name, avatarUrl = avatarUrl, size = 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Text(
                        persona.name,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (isDefault) {
                        Pill(
                            "Default",
                            container = MaterialTheme.colorScheme.primary,
                            content = MaterialTheme.colorScheme.onPrimary,
                        )
                    }
                    if (isAnsweringOpenChat) {
                        Pill(
                            "Answering the open chat",
                            container = Color.Transparent,
                            content = MaterialTheme.colorScheme.primary,
                            outlined = true,
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                // The design clamps the SYSTEM PROMPT here, not the description:
                // the prompt is what actually changes the answers, so two lines
                // of it tell you which persona this is.
                Text(
                    persona.systemPrompt.ifBlank { "No system prompt — answers in the default voice." },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    personaMeta(
                        persona.voiceReference,
                        persona.characterConfig != null,
                        persona.enabled,
                    ),
                    style = KurisuTheme.extraTypography.metadataSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onEdit) {
                Icon(
                    Icons.Outlined.Edit,
                    contentDescription = "Edit ${persona.name}",
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun Pill(
    text: String,
    container: Color,
    content: Color,
    outlined: Boolean = false,
) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = container,
        contentColor = content,
        border = if (outlined) {
            androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary)
        } else null,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            maxLines = 1,
        )
    }
}

// ─── Editor ───────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PersonaEditor(
    draft: PersonaDraft,
    avatarUrl: String?,
    availableVoices: List<String>,
    isSaving: Boolean,
    isUploadingAvatar: Boolean,
    onPickAvatar: (File) -> Unit,
    onNameChange: (String) -> Unit,
    onDescriptionChange: (String) -> Unit,
    onPreferredNameChange: (String) -> Unit,
    onVoiceChange: (String) -> Unit,
    onPreviewVoice: () -> Unit,
    onSystemPromptChange: (String) -> Unit,
    onEnabledChange: (Boolean) -> Unit,
    onPreviewCharacter: ((personaId: Int) -> Unit)?,
    onDelete: () -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var voiceMenuOpen by remember { mutableStateOf(false) }

    val avatarPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let { copyToCache(context, it)?.let(onPickAvatar) }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onCancel) { Text("Cancel") }
                Text(
                    if (draft.isNew) "New persona" else "Edit persona",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
                TextButton(onClick = onSave, enabled = !isSaving) {
                    Text(if (draft.isNew) "Create" else "Save")
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        PersonaAvatar(
                            name = draft.name.ifBlank { "?" },
                            avatarUrl = avatarUrl,
                            size = 72.dp,
                        )
                        if (isUploadingAvatar) CircularProgressIndicator(Modifier.size(28.dp))
                    }
                    OutlinedButton(
                        onClick = { avatarPicker.launch("image/*") },
                        enabled = !isUploadingAvatar,
                    ) {
                        Text(if (draft.avatarUuid == null) "Choose a picture" else "Change picture")
                    }
                }

                Field(label = "Persona name", helper = "Shown on every message it answers") {
                    OutlinedTextField(
                        value = draft.name,
                        onValueChange = onNameChange,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Field(
                    label = "Description",
                    helper = "A note to yourself. It travels with the persona when you export it.",
                ) {
                    OutlinedTextField(
                        value = draft.description,
                        onValueChange = onDescriptionChange,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                // preferred_name is what the persona calls the USER — the backend
                // appends "The user prefers to be called: …" to the prompt
                // (agents/main.py). It is not a second display name.
                Field(label = "Calls you", helper = "What this persona calls you when it answers") {
                    OutlinedTextField(
                        value = draft.preferredName,
                        onValueChange = onPreferredNameChange,
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("Your name") },
                    )
                }

                Field(label = "Voice", helper = null) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        ExposedDropdownMenuBox(
                            expanded = voiceMenuOpen,
                            onExpandedChange = { voiceMenuOpen = it },
                            modifier = Modifier.weight(1f),
                        ) {
                            OutlinedTextField(
                                value = draft.voiceReference,
                                onValueChange = {},
                                readOnly = true,
                                singleLine = true,
                                placeholder = { Text("None") },
                                textStyle = KurisuTheme.extraTypography.metadata,
                                modifier = Modifier.fillMaxWidth().menuAnchor(),
                                trailingIcon = {
                                    ExposedDropdownMenuDefaults.TrailingIcon(expanded = voiceMenuOpen)
                                },
                            )
                            ExposedDropdownMenu(
                                expanded = voiceMenuOpen,
                                onDismissRequest = { voiceMenuOpen = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text("None") },
                                    onClick = {
                                        onVoiceChange("")
                                        voiceMenuOpen = false
                                    },
                                )
                                if (availableVoices.isEmpty()) {
                                    DropdownMenuItem(
                                        enabled = false,
                                        text = {
                                            Text(
                                                "No voices available",
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        },
                                        onClick = {},
                                    )
                                }
                                availableVoices.forEach { voice ->
                                    DropdownMenuItem(
                                        text = {
                                            Text(voice, style = KurisuTheme.extraTypography.metadata)
                                        },
                                        onClick = {
                                            onVoiceChange(voice)
                                            voiceMenuOpen = false
                                        },
                                    )
                                }
                            }
                        }
                        IconButton(
                            onClick = onPreviewVoice,
                            enabled = draft.voiceReference.isNotBlank(),
                        ) {
                            Icon(Icons.Outlined.PlayArrow, contentDescription = "Hear this voice")
                        }
                    }
                }

                Field(
                    label = "System prompt",
                    helper = "Replaces the assistant's prompt. Skills are still appended after it.",
                ) {
                    OutlinedTextField(
                        value = draft.systemPrompt,
                        onValueChange = onSystemPromptChange,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 150.dp),
                        textStyle = KurisuTheme.extraTypography.code,
                    )
                }

                CharacterRow(
                    personaId = draft.id,
                    configured = draft.hasCharacterConfig,
                    onPreviewCharacter = onPreviewCharacter,
                )

                if (!draft.isNew) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Enabled", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "A disabled persona cannot answer or be the default",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = draft.enabled,
                            onCheckedChange = onEnabledChange,
                            enabled = !isSaving,
                        )
                    }

                    OutlinedButton(
                        onClick = onDelete,
                        colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("Delete persona")
                    }
                }
            }
        }
    }
}

@Composable
private fun Field(
    label: String,
    helper: String?,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        content()
        if (helper != null) {
            Text(
                helper,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Character animation, read-only.
 *
 * Android has no character-config editor — poses, the transition graph and the
 * lip-sync mapping are authored on the desktop client — and inventing a graph
 * editor here is far outside this screen. So the row reports whether a rig
 * exists and says where it is edited. When the nav graph offers somewhere to
 * preview it, the row becomes tappable; otherwise it stays a status line rather
 * than a chevron that leads nowhere.
 */
@Composable
private fun CharacterRow(
    personaId: Int?,
    configured: Boolean,
    onPreviewCharacter: ((personaId: Int) -> Unit)?,
) {
    val canPreview = configured && personaId != null && onPreviewCharacter != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (canPreview) Modifier.clickable { onPreviewCharacter!!(personaId!!) }
                else Modifier
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("Character animation", style = MaterialTheme.typography.bodyLarge)
            Text(
                "Poses, blink and lip sync — edited on the desktop client",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            if (configured) "Configured" else "None",
            style = KurisuTheme.extraTypography.metadata,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (canPreview) {
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = "Preview the character",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Copy a picked image out of the content provider and into the cache, because
 * the upload needs a real file and a `content://` URI is not one.
 */
private fun copyToCache(context: Context, uri: Uri): File? = runCatching {
    val extension = when (context.contentResolver.getType(uri)) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        else -> "jpg"
    }
    val target = File(context.cacheDir, "persona_avatar_${System.currentTimeMillis()}.$extension")
    context.contentResolver.openInputStream(uri)?.use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
    } ?: return@runCatching null
    target
}.getOrNull()
