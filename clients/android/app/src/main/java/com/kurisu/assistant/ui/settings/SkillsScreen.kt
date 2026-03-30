package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel

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
                    Text("Skills inject instructions into agent prompts", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = viewModel::openNewEditor) { Text("Create your first skill") }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.skills, key = { it.id }) { skill ->
                    Card(modifier = Modifier.fillMaxWidth(), onClick = { viewModel.openEditEditor(skill) }) {
                        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(skill.name, style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    skill.instructions,
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 4,
                                    overflow = TextOverflow.Ellipsis,
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
