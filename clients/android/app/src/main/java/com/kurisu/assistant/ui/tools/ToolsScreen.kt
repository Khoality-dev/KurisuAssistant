package com.kurisu.assistant.ui.tools

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.Skill
import com.kurisu.assistant.data.model.Tool
import kotlinx.serialization.json.JsonObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolsScreen(
    onBack: () -> Unit,
    viewModel: ToolsViewModel = hiltViewModel(),
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
                title = { Text("Tools & Skills") },
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
            if (state.selectedTab == 2) {
                FloatingActionButton(onClick = viewModel::openNewSkillEditor) {
                    Icon(Icons.Default.Add, contentDescription = "New Skill")
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = state.selectedTab) {
                Tab(
                    selected = state.selectedTab == 0,
                    onClick = { viewModel.setSelectedTab(0) },
                    text = { Text("Servers") },
                )
                Tab(
                    selected = state.selectedTab == 1,
                    onClick = { viewModel.setSelectedTab(1) },
                    text = { Text("Tools") },
                )
                Tab(
                    selected = state.selectedTab == 2,
                    onClick = { viewModel.setSelectedTab(2) },
                    text = { Text("Skills") },
                )
            }

            if (state.isLoading) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            } else {
                when (state.selectedTab) {
                    0 -> ServersTab(state.mcpServers)
                    1 -> ToolsTab(
                        mcpTools = state.mcpTools,
                        builtinTools = state.builtinTools,
                        onToolClick = viewModel::showToolDetail,
                    )
                    2 -> SkillsTab(
                        skills = state.skills,
                        onEdit = viewModel::openEditSkillEditor,
                        onDelete = viewModel::confirmDeleteSkill,
                        onCreateFirst = viewModel::openNewSkillEditor,
                    )
                }
            }
        }
    }

    // Dialogs
    state.detailTool?.let { tool ->
        ToolDetailDialog(
            tool = tool,
            onDismiss = viewModel::dismissToolDetail,
        )
    }

    if (state.showSkillEditor) {
        SkillEditorDialog(
            isEditing = state.editingSkill != null,
            name = state.skillEditorName,
            instructions = state.skillEditorInstructions,
            isSaving = state.isSavingSkill,
            onNameChange = viewModel::setSkillEditorName,
            onInstructionsChange = viewModel::setSkillEditorInstructions,
            onSave = viewModel::saveSkill,
            onDismiss = viewModel::dismissSkillEditor,
        )
    }

    state.deletingSkill?.let { skill ->
        AlertDialog(
            onDismissRequest = viewModel::dismissDeleteSkill,
            title = { Text("Delete Skill") },
            text = { Text("Delete \"${skill.name}\"? This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = viewModel::deleteSkill) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDeleteSkill) { Text("Cancel") }
            },
        )
    }
}

// --- Servers Tab ---

@Composable
private fun ServersTab(servers: List<MCPServer>) {
    if (servers.isEmpty()) {
        EmptyState("No MCP servers configured")
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(servers, key = { it.id }) { server ->
                ServerCard(server)
            }
        }
    }
}

@Composable
private fun ServerCard(server: MCPServer) {
    val statusColor = if (server.enabled) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (server.enabled) {
                MaterialTheme.colorScheme.surface
            } else {
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            },
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = server.name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(
                            text = server.transportType.uppercase(),
                            style = MaterialTheme.typography.labelSmall,
                            color = statusColor,
                        )
                    },
                )
            }
            Spacer(Modifier.height(4.dp))
            val connectionDetail = if (server.transportType == "sse") {
                server.url ?: "(no URL)"
            } else {
                buildString {
                    append(server.command ?: "")
                    if (!server.args.isNullOrEmpty()) {
                        append(" ")
                        append(server.args.joinToString(" "))
                    }
                }
            }
            Text(
                text = connectionDetail,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// --- Tools Tab ---

@Composable
private fun ToolsTab(
    mcpTools: List<Tool>,
    builtinTools: List<Tool>,
    onToolClick: (Tool) -> Unit,
) {
    if (mcpTools.isEmpty() && builtinTools.isEmpty()) {
        EmptyState("No tools available")
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (builtinTools.isNotEmpty()) {
                item {
                    Text(
                        text = "Built-in",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(bottom = 4.dp),
                    )
                }
                items(builtinTools, key = { "builtin-${it.function.name}" }) { tool ->
                    ToolCard(tool = tool, source = "Built-in", onClick = { onToolClick(tool) })
                }
            }
            if (mcpTools.isNotEmpty()) {
                item {
                    Text(
                        text = "MCP",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = if (builtinTools.isNotEmpty()) 8.dp else 0.dp, bottom = 4.dp),
                    )
                }
                items(mcpTools, key = { "mcp-${it.function.name}" }) { tool ->
                    ToolCard(tool = tool, source = "MCP", onClick = { onToolClick(tool) })
                }
            }
        }
    }
}

@Composable
private fun ToolCard(tool: Tool, source: String, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = tool.function.name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                SuggestionChip(
                    onClick = {},
                    label = {
                        Text(text = source, style = MaterialTheme.typography.labelSmall)
                    },
                )
            }
            if (tool.function.description.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = tool.function.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// --- Skills Tab ---

@Composable
private fun SkillsTab(
    skills: List<Skill>,
    onEdit: (Skill) -> Unit,
    onDelete: (Skill) -> Unit,
    onCreateFirst: () -> Unit,
) {
    if (skills.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "No skills yet",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Button(onClick = onCreateFirst) {
                    Text("Create your first skill")
                }
            }
        }
    } else {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(skills, key = { it.id }) { skill ->
                SkillCard(skill = skill, onEdit = { onEdit(skill) }, onDelete = { onDelete(skill) })
            }
        }
    }
}

@Composable
private fun SkillCard(skill: Skill, onEdit: () -> Unit, onDelete: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = skill.name,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onEdit, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = "Edit",
                        modifier = Modifier.size(18.dp),
                    )
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Delete",
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
            if (skill.instructions.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = skill.instructions,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// --- Dialogs ---

@Composable
private fun ToolDetailDialog(tool: Tool, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(tool.function.name) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                if (tool.function.description.isNotBlank()) {
                    Text(
                        text = tool.function.description,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                val params = tool.function.parameters
                if (params != JsonObject(emptyMap())) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "Parameters",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = params.toString(),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}

@Composable
private fun SkillEditorDialog(
    isEditing: Boolean,
    name: String,
    instructions: String,
    isSaving: Boolean,
    onNameChange: (String) -> Unit,
    onInstructionsChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isEditing) "Edit Skill" else "New Skill") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = onNameChange,
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = instructions,
                    onValueChange = onInstructionsChange,
                    label = { Text("Instructions") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 150.dp),
                    maxLines = 12,
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

// --- Shared ---

@Composable
private fun EmptyState(text: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
