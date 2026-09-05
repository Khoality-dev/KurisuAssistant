package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.foundation.shape.RoundedCornerShape
import com.kurisu.assistant.ui.theme.JetBrainsMono
import com.kurisu.assistant.ui.theme.KurisuTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SkillsScreen(
    onBack: () -> Unit,
    viewModel: SkillsViewModel = hiltViewModel(),
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
                title = { Text("Skills") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::loadSkills) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            FloatingActionButton(onClick = viewModel::openNewEditor) {
                Icon(Icons.Default.Add, contentDescription = "New Skill")
            }
        },
    ) { padding ->
        if (state.isLoading && state.skills.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else if (state.skills.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No skills yet", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    Text("Skills inject instructions into the assistant's prompt", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = viewModel::openNewEditor) { Text("Create your first skill") }
                }
            }
        } else {
            Column(modifier = Modifier.fillMaxSize().padding(padding)) {
                // The order is the order they are appended in, so the list says so
                // and every row carries its 1-based position.
                Column(
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        "Every skill below is appended to the system prompt of the assistant, in this order.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = state.skills.size.let { if (it == 1) "1 skill" else "$it skills" },
                        style = KurisuTheme.extraTypography.metadataSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 88.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    itemsIndexed(state.skills, key = { _, skill -> skill.id }) { index, skill ->
                        Card(modifier = Modifier.fillMaxWidth(), onClick = { viewModel.openEditEditor(skill) }) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.Top,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                OrdinalBadge(index + 1)
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(skill.name, style = MaterialTheme.typography.titleSmall)
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        skill.instructions,
                                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = JetBrainsMono, fontSize = 11.sp),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 4,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        text = skill.instructions.trim().length.let { "$it characters" },
                                        style = KurisuTheme.extraTypography.metadataSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                IconButton(onClick = { viewModel.confirmDelete(skill) }, modifier = Modifier.size(36.dp)) {
                                    Icon(Icons.Default.Delete, contentDescription = "Delete", modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Editor dialog
    if (state.showEditor) {
        AlertDialog(
            onDismissRequest = viewModel::dismissEditor,
            title = { Text(if (state.editingSkill != null) "Edit Skill" else "New Skill") },
            text = {
                Column(modifier = Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = state.editorName,
                        onValueChange = viewModel::setEditorName,
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = state.editorInstructions,
                        onValueChange = viewModel::setEditorInstructions,
                        label = { Text("Instructions") },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
                        maxLines = 12,
                    )
                }
            },
            confirmButton = { TextButton(onClick = viewModel::saveSkill, enabled = !state.isSaving) { Text(if (state.editingSkill != null) "Save" else "Create") } },
            dismissButton = { TextButton(onClick = viewModel::dismissEditor) { Text("Cancel") } },
        )
    }

    // Delete confirmation
    state.deletingSkill?.let { skill ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDelete,
            title = { Text("Delete Skill") },
            text = { Text("Delete \"${skill.name}\"?") },
            confirmButton = { TextButton(onClick = viewModel::deleteSkill) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = viewModel::dismissDelete) { Text("Cancel") } },
        )
    }
}

/**
 * The skill's place in the order it is appended in. Display-only: the backend
 * `Skill` row has no position column, so this is the list index, not a stored
 * field, and it renumbers itself when a skill is deleted.
 */
@Composable
private fun OrdinalBadge(position: Int) {
    Surface(
        modifier = Modifier.size(26.dp),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = position.toString(),
                style = KurisuTheme.extraTypography.metadataSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}
