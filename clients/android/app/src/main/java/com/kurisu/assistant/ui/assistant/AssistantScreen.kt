package com.kurisu.assistant.ui.assistant

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
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
import com.kurisu.assistant.ui.common.ModelDropdown
import com.kurisu.assistant.ui.personas.PersonaAvatar
import com.kurisu.assistant.ui.theme.KurisuTheme

/**
 * The user's single assistant: what it can do.
 *
 * Everything on this screen is one row, patched a field at a time through
 * `PATCH /assistant`. The screen that this replaces listed "main agents", each
 * with its own model, tools and memory; there is one of each now. There are no
 * sub-agents to set up (#354): the assistant spawns one itself when it needs
 * help, on its own model and tools. There is no tool list either (#360): every
 * tool is always available, and how much runs without asking is the permission
 * mode beside the chat input.
 *
 * Two things that look like they belong here do not (#197). The model is picked
 * from the chat header, beside the persona, because that is where the question
 * comes up — and it is one model for every persona, so it is no more a persona's
 * than the memory is. The persona in use is chosen on the Personas screen or the
 * chat header. Neither is a capability, so neither is on this page.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssistantScreen(
    onBack: () -> Unit,
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
                        "One assistant answers you. Personas change how it sounds; it hands side tasks to sub-agents it spawns itself.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }

                item("capabilities") {
                    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(vertical = 4.dp)) {
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
                        }
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
}

// ─── Rows ─────────────────────────────────────────────────────────────

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
                    "Saying it starts a voice turn. The persona in use answers — " +
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

