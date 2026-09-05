package com.kurisu.assistant.ui.assistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.SubAgent
import com.kurisu.assistant.ui.common.ModelDropdown
import com.kurisu.assistant.ui.personas.PersonaAvatar
import com.kurisu.assistant.ui.personas.personaMeta
import com.kurisu.assistant.ui.theme.KurisuTheme

/**
 * The user's single assistant: what it can do, and who answers by default.
 *
 * Everything on this screen except the default-persona card and the sub-agent
 * list is one row, patched a field at a time through `PATCH /assistant`. The
 * screen that this replaces listed "main agents", each with its own model, tools
 * and memory; there is one of each now, and the personas that used to carry them
 * are one tap away behind the card at the top.
 *
 * @param onNavigateToPersonas opens the Personas list. Wired by the nav graph.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssistantScreen(
    onBack: () -> Unit,
    onNavigateToPersonas: () -> Unit,
    viewModel: AssistantViewModel = hiltViewModel(),
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
                title = { Text("Assistant") },
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
            if (state.assistant != null) {
                ExtendedFloatingActionButton(
                    onClick = viewModel::openNewSubAgent,
                    icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                    text = { Text("New sub-agent") },
                )
            }
        },
    ) { padding ->
        val assistant = state.assistant
        when {
            state.isLoading && assistant == null -> LoadingBox(Modifier.padding(padding))

            assistant == null -> ErrorBox(
                message = state.loadError ?: "The assistant could not be loaded.",
                onRetry = viewModel::load,
                modifier = Modifier.padding(padding),
            )

            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item("intro") {
                    Text(
                        "One assistant answers you. Personas change how it sounds; sub-agents are workers it calls.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }

                item("default_persona") {
                    DefaultPersonaCard(
                        personaName = state.defaultPersona?.name,
                        meta = state.defaultPersona?.let {
                            personaMeta(it.voiceReference, it.characterConfig != null, it.enabled)
                        },
                        avatarUrl = state.defaultPersona?.avatarUuid?.let {
                            "${state.baseUrl.trimEnd('/')}/images/$it"
                        },
                        onClick = onNavigateToPersonas,
                    )
                }

                item("capabilities") {
                    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(vertical = 4.dp)) {
                            ModelDropdown(
                                label = "Model",
                                value = assistant.modelName.orEmpty(),
                                onValueChange = { name ->
                                    state.availableModels.firstOrNull { it.name == name }
                                        ?.let(viewModel::setModel)
                                },
                                availableModels = state.availableModels,
                                isRefreshing = state.isRefreshingModels,
                                onRefresh = viewModel::refreshModels,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                                supportingText = {
                                    Text(
                                        assistant.providerType,
                                        style = KurisuTheme.extraTypography.metadataSmall,
                                    )
                                },
                            )

                            RowDivider()

                            // Decision: the wake word is the ASSISTANT's, not a
                            // persona's. It wakes the assistant and the
                            // conversation's own persona answers — it selects
                            // nobody, which is why the persona editor has no
                            // field for it and this row says so out loud.
                            ValueRow(
                                label = "Trigger word",
                                value = state.triggerWord ?: "Not set",
                                supporting = "Voice wake word — say it to start talking. It does not pick a persona.",
                                trailing = {
                                    Icon(
                                        Icons.Outlined.Edit,
                                        contentDescription = "Edit the trigger word",
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.size(20.dp),
                                    )
                                },
                                onClick = viewModel::openTriggerEditor,
                            )

                            RowDivider()

                            SwitchRow(
                                title = "Think mode",
                                subtitle = "Reasoning before the answer",
                                checked = assistant.think,
                                enabled = !state.isSaving,
                                onCheckedChange = viewModel::setThink,
                            )

                            RowDivider()

                            SwitchRow(
                                title = "Memory",
                                subtitle = "Carried across every conversation",
                                checked = assistant.memoryEnabled,
                                enabled = !state.isSaving,
                                onCheckedChange = viewModel::setMemoryEnabled,
                            )

                            // The design draws the memory document under the
                            // switch without saying what an off switch does to
                            // it. Collapsing it is the only reading that is not a
                            // lie: with memory off nothing is carried, so showing
                            // the document would suggest it still applies.
                            if (assistant.memoryEnabled) {
                                MemoryDocument(assistant.memory)
                            }

                            RowDivider()

                            ValueRow(
                                label = "Tools",
                                value = state.toolsSummary,
                                supporting = null,
                                trailing = {
                                    Icon(
                                        Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                },
                                onClick = viewModel::openToolPicker,
                            )
                        }
                    }
                }

                item("subagents_header") {
                    Column(modifier = Modifier.padding(top = 16.dp, bottom = 2.dp)) {
                        Text("Sub-agents", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Task-only workers the assistant calls",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                if (state.subAgents.isEmpty()) {
                    item("subagents_empty") {
                        EmptySubAgents(onCreate = viewModel::openNewSubAgent)
                    }
                } else {
                    items(state.subAgents, key = { it.id }) { subAgent ->
                        SubAgentCard(
                            subAgent = subAgent,
                            onEdit = { viewModel.openSubAgentEditor(subAgent) },
                            onDelete = { viewModel.confirmDeleteSubAgent(subAgent) },
                        )
                    }
                }
            }
        }
    }

    if (state.triggerEditorOpen) {
        TriggerWordDialog(
            value = state.triggerDraft,
            onValueChange = viewModel::setTriggerDraft,
            onSave = viewModel::saveTriggerWord,
            onDismiss = viewModel::dismissTriggerEditor,
        )
    }

    if (state.toolPickerOpen) {
        ToolPickerDialog(
            allTools = state.allToolNames,
            selected = state.toolDraft,
            usesEveryToolToday = state.usesEveryTool,
            onToggle = viewModel::toggleToolDraft,
            onSelectAll = viewModel::selectAllToolDrafts,
            onClearAll = viewModel::clearToolDrafts,
            onSave = viewModel::saveTools,
            onDismiss = viewModel::dismissToolPicker,
        )
    }

    if (state.subEditorOpen) {
        SubAgentEditorDialog(state = state, viewModel = viewModel)
    }

    state.deletingSubAgent?.let { subAgent ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDeleteSubAgent,
            title = { Text("Delete sub-agent") },
            text = { Text("Delete \"${subAgent.name}\"? The assistant can no longer call it.") },
            confirmButton = {
                TextButton(onClick = viewModel::deleteSubAgent) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDeleteSubAgent) { Text("Cancel") }
            },
        )
    }
}

// ─── Rows ─────────────────────────────────────────────────────────────

@Composable
private fun DefaultPersonaCard(
    personaName: String?,
    meta: String?,
    avatarUrl: String?,
    onClick: () -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PersonaAvatar(name = personaName ?: "?", avatarUrl = avatarUrl, size = 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "DEFAULT PERSONA",
                    style = KurisuTheme.extraTypography.metadataSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    personaName ?: "No default persona",
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    meta ?: "New chats have nobody to answer them yet.",
                    style = KurisuTheme.extraTypography.metadata,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun RowDivider() = HorizontalDivider(
    modifier = Modifier.padding(horizontal = 14.dp),
    color = MaterialTheme.colorScheme.outlineVariant,
)

@Composable
private fun ValueRow(
    label: String,
    value: String,
    supporting: String?,
    trailing: @Composable () -> Unit,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(2.dp))
            Text(value, style = KurisuTheme.extraTypography.metadata)
            if (supporting != null) {
                Spacer(Modifier.height(3.dp))
                Text(
                    supporting,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        trailing()
    }
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
private fun MemoryDocument(memory: String?) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp)) {
            Text(
                memory?.takeIf { it.isNotBlank() }
                    ?: "Nothing remembered yet. It fills in as you talk.",
                style = MaterialTheme.typography.bodyMedium,
                color = if (memory.isNullOrBlank()) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Auto-consolidated from your conversations — read-only here.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SubAgentCard(
    subAgent: SubAgent,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth(), onClick = onEdit) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PersonaAvatar(
                name = subAgent.name,
                avatarUrl = null,
                size = 48.dp,
                containerColor = MaterialTheme.colorScheme.surfaceVariant,
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    subAgent.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    subAgent.modelName ?: "the assistant's model",
                    style = KurisuTheme.extraTypography.metadataSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(5.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (subAgent.think) TagChip("Think")
                    val toolCount = subAgent.availableTools?.size
                    TagChip(
                        when (toolCount) {
                            null -> "every tool"
                            0 -> "no tools"
                            1 -> "1 tool"
                            else -> "$toolCount tools"
                        }
                    )
                    if (!subAgent.enabled) TagChip("Disabled")
                }
            }
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Outlined.Delete,
                    contentDescription = "Delete ${subAgent.name}",
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun TagChip(label: String) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Text(
            label,
            style = KurisuTheme.extraTypography.metadataSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

// ─── Empty / loading / error ──────────────────────────────────────────

@Composable
private fun LoadingBox(modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun ErrorBox(message: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                message,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = onRetry) { Text("Try again") }
        }
    }
}

@Composable
private fun EmptySubAgents(onCreate: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "No sub-agents yet",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        Button(onClick = onCreate) { Text("New sub-agent") }
    }
}

// ─── Dialogs ──────────────────────────────────────────────────────────

@Composable
private fun TriggerWordDialog(
    value: String,
    onValueChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Trigger word") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    label = { Text("Wake word") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Saying it starts a voice turn. Whoever is bound to the conversation answers — " +
                        "the wake word never picks a persona. Leave it empty to turn it off.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onSave) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolPickerDialog(
    allTools: List<String>,
    selected: Set<String>,
    usesEveryToolToday: Boolean,
    onToggle: (String) -> Unit,
    onSelectAll: () -> Unit,
    onClearAll: () -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Tools") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (allTools.isEmpty()) {
                    Text(
                        "No tools are available. Add an MCP server under Tools & MCP.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        if (usesEveryToolToday) {
                            "The assistant can use every tool. Turning one off pins it to the list you pick here."
                        } else {
                            "${selected.size} of ${allTools.size} enabled."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = onSelectAll) { Text("Select all") }
                        TextButton(onClick = onClearAll) { Text("Clear") }
                    }
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        allTools.forEach { name ->
                            FilterChip(
                                selected = name in selected,
                                onClick = { onToggle(name) },
                                label = {
                                    Text(name, style = KurisuTheme.extraTypography.metadataSmall)
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onSave, enabled = allTools.isNotEmpty()) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SubAgentEditorDialog(
    state: AssistantUiState,
    viewModel: AssistantViewModel,
) {
    AlertDialog(
        onDismissRequest = viewModel::dismissSubAgentEditor,
        title = {
            Text(if (state.editingSubAgent != null) "Edit sub-agent" else "New sub-agent")
        },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedTextField(
                    value = state.subDraftName,
                    onValueChange = viewModel::setSubDraftName,
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = state.subDraftDescription,
                    onValueChange = viewModel::setSubDraftDescription,
                    label = { Text("Description") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("How the assistant decides to call it") },
                )
                ModelDropdown(
                    label = "Model",
                    value = state.subDraftModelName,
                    onValueChange = viewModel::setSubDraftModelName,
                    availableModels = state.availableModels,
                    isRefreshing = state.isRefreshingModels,
                    onRefresh = viewModel::refreshModels,
                )
                OutlinedTextField(
                    value = state.subDraftSystemPrompt,
                    onValueChange = viewModel::setSubDraftSystemPrompt,
                    label = { Text("System prompt") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    maxLines = 8,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Think mode", modifier = Modifier.weight(1f))
                    Switch(
                        checked = state.subDraftThink,
                        onCheckedChange = viewModel::setSubDraftThink,
                    )
                }
                if (state.allToolNames.isNotEmpty()) {
                    Text("Tools", style = MaterialTheme.typography.titleSmall)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        state.allToolNames.forEach { name ->
                            FilterChip(
                                selected = name in state.subDraftTools,
                                onClick = { viewModel.toggleSubDraftTool(name) },
                                label = {
                                    Text(name, style = KurisuTheme.extraTypography.metadataSmall)
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = viewModel::saveSubAgent, enabled = !state.isSaving) {
                Text(if (state.editingSubAgent != null) "Save" else "Create")
            }
        },
        dismissButton = {
            TextButton(onClick = viewModel::dismissSubAgentEditor) { Text("Cancel") }
        },
    )
}
