package com.kurisu.assistant.ui.agents

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Edit
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
import com.kurisu.assistant.data.model.Agent

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentsScreen(
    onBack: () -> Unit,
    viewModel: AgentsViewModel = hiltViewModel(),
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
                title = { Text("Agents") },
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
                Icon(Icons.Default.Add, contentDescription = "New Agent")
            }
        },
    ) { padding ->
        if (state.isLoading && state.agents.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        } else if (state.agents.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "No agents yet",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = viewModel::openNewEditor) {
                        Text("Create your first agent")
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.agents, key = { it.id }) { agent ->
                    AgentCard(
                        agent = agent,
                        baseUrl = state.baseUrl,
                        onEdit = { viewModel.openEditEditor(agent) },
                        onDelete = { viewModel.confirmDelete(agent) },
                    )
                }
            }
        }
    }

    // Editor dialog
    if (state.showEditor) {
        AgentEditorDialog(
            isEditing = state.editingAgent != null,
            avatarUrl = state.editingAgent?.avatarUuid?.let {
                "${state.baseUrl.trimEnd('/')}/images/$it"
            },
            name = state.editorName,
            modelName = state.editorModelName,
            systemPrompt = state.editorSystemPrompt,
            triggerWord = state.editorTriggerWord,
            think = state.editorThink,
            tools = state.editorTools,
            memory = state.editorMemory,
            availableModels = state.availableModels,
            availableTools = state.availableTools.map { it.function.name },
            isSaving = state.isSaving,
            onNameChange = viewModel::setEditorName,
            onModelNameChange = viewModel::setEditorModelName,
            onSystemPromptChange = viewModel::setEditorSystemPrompt,
            onTriggerWordChange = viewModel::setEditorTriggerWord,
            onThinkChange = viewModel::setEditorThink,
            onToggleTool = viewModel::toggleEditorTool,
            onMemoryChange = viewModel::setEditorMemory,
            onSave = viewModel::saveAgent,
            onDismiss = viewModel::dismissEditor,
        )
    }

    // Delete confirmation
    state.deletingAgent?.let { agent ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDelete,
            title = { Text("Delete Agent") },
            text = { Text("Delete \"${agent.name}\"? This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = viewModel::deleteAgent) {
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
private fun AgentCard(
    agent: Agent,
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
            AgentAvatar(
                name = agent.name,
                avatarUrl = agent.avatarUuid?.let { "${baseUrl.trimEnd('/')}/images/$it" },
                size = 48,
            )

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = agent.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (agent.modelName != null) {
                    Text(
                        text = agent.modelName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // Tags
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (agent.think) {
                        SuggestionChip(
                            onClick = {},
                            label = { Text("Think", style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                    if (agent.triggerWord != null) {
                        SuggestionChip(
                            onClick = {},
                            label = { Text(agent.triggerWord, style = MaterialTheme.typography.labelSmall) },
                        )
                    }
                    val toolCount = agent.tools?.size ?: 0
                    if (toolCount > 0) {
                        SuggestionChip(
                            onClick = {},
                            label = { Text("$toolCount tools", style = MaterialTheme.typography.labelSmall) },
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

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun AgentEditorDialog(
    isEditing: Boolean,
    avatarUrl: String?,
    name: String,
    modelName: String,
    systemPrompt: String,
    triggerWord: String,
    think: Boolean,
    tools: List<String>,
    memory: String,
    availableModels: List<String>,
    availableTools: List<String>,
    isSaving: Boolean,
    onNameChange: (String) -> Unit,
    onModelNameChange: (String) -> Unit,
    onSystemPromptChange: (String) -> Unit,
    onTriggerWordChange: (String) -> Unit,
    onThinkChange: (Boolean) -> Unit,
    onToggleTool: (String) -> Unit,
    onMemoryChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    var modelDropdownExpanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isEditing) "Edit Agent" else "New Agent") },
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
                        AgentAvatar(name = name, avatarUrl = avatarUrl, size = 72)
                    }
                }

                OutlinedTextField(
                    value = name,
                    onValueChange = onNameChange,
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Model selector
                ExposedDropdownMenuBox(
                    expanded = modelDropdownExpanded,
                    onExpandedChange = { modelDropdownExpanded = it },
                ) {
                    OutlinedTextField(
                        value = modelName,
                        onValueChange = onModelNameChange,
                        label = { Text("Model") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().menuAnchor(),
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelDropdownExpanded) },
                    )
                    if (availableModels.isNotEmpty()) {
                        ExposedDropdownMenu(
                            expanded = modelDropdownExpanded,
                            onDismissRequest = { modelDropdownExpanded = false },
                        ) {
                            availableModels.forEach { model ->
                                DropdownMenuItem(
                                    text = { Text(model) },
                                    onClick = {
                                        onModelNameChange(model)
                                        modelDropdownExpanded = false
                                    },
                                )
                            }
                        }
                    }
                }

                OutlinedTextField(
                    value = systemPrompt,
                    onValueChange = onSystemPromptChange,
                    label = { Text("System Prompt") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    maxLines = 8,
                )

                OutlinedTextField(
                    value = triggerWord,
                    onValueChange = onTriggerWordChange,
                    label = { Text("Trigger Word") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Voice activation keyword") },
                )

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Think mode", modifier = Modifier.weight(1f))
                    Switch(checked = think, onCheckedChange = onThinkChange)
                }

                // Tools multi-select
                if (availableTools.isNotEmpty()) {
                    Text("Tools", style = MaterialTheme.typography.titleSmall)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        availableTools.forEach { toolName ->
                            FilterChip(
                                selected = toolName in tools,
                                onClick = { onToggleTool(toolName) },
                                label = { Text(toolName, style = MaterialTheme.typography.labelSmall) },
                            )
                        }
                    }
                }

                if (isEditing) {
                    OutlinedTextField(
                        value = memory,
                        onValueChange = onMemoryChange,
                        label = { Text("Memory") },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
                        maxLines = 6,
                        supportingText = { Text("Auto-consolidated from conversations") },
                    )
                }
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
private fun AgentAvatar(name: String, avatarUrl: String?, size: Int) {
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
