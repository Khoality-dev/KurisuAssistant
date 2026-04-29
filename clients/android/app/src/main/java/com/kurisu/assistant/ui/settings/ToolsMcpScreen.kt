package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.PlayArrow
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
import com.kurisu.assistant.data.model.MCPServer
import com.kurisu.assistant.data.model.Tool

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolsMcpScreen(
    onBack: () -> Unit,
    viewModel: ToolsMcpViewModel = hiltViewModel(),
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
                title = { Text("Tools & MCP") },
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
        floatingActionButton = {
            if (state.selectedTab == 0) {
                FloatingActionButton(onClick = viewModel::openCreateServer) {
                    Icon(Icons.Default.Add, contentDescription = "Add MCP server")
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = state.selectedTab) {
                Tab(selected = state.selectedTab == 0, onClick = { viewModel.setSelectedTab(0) }) {
                    Text("Servers", modifier = Modifier.padding(12.dp))
                }
                Tab(selected = state.selectedTab == 1, onClick = { viewModel.setSelectedTab(1) }) {
                    Text("Tools", modifier = Modifier.padding(12.dp))
                }
            }

            if (state.isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else when (state.selectedTab) {
                0 -> ServersList(
                    servers = state.mcpServers,
                    meta = state.serverMeta,
                    onEdit = viewModel::openEditServer,
                    onDelete = viewModel::confirmDeleteServer,
                    onTest = viewModel::testServer,
                    onToggleEnabled = viewModel::toggleServerEnabled,
                )
                1 -> ToolsList(
                    builtinTools = state.builtinTools,
                    mcpTools = state.mcpTools,
                    onToolClick = viewModel::showToolDetail,
                )
            }
        }
    }

    // Tool detail dialog
    state.detailTool?.let { tool ->
        AlertDialog(
            onDismissRequest = viewModel::dismissToolDetail,
            confirmButton = { TextButton(onClick = viewModel::dismissToolDetail) { Text("Close") } },
            title = { Text(tool.function.name) },
            text = {
                Column(
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(tool.function.description, style = MaterialTheme.typography.bodyMedium)
                    if (tool.function.parameters.isNotEmpty()) {
                        Text("Parameters", style = MaterialTheme.typography.titleSmall)
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(6.dp)) {
                            Text(
                                text = tool.function.parameters.toString(),
                                style = MaterialTheme.typography.bodySmall.copy(
                                    fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                                ),
                                modifier = Modifier.padding(8.dp),
                            )
                        }
                    }
                }
            },
        )
    }

    // Server form dialog
    state.serverForm?.let { form ->
        McpServerFormDialog(
            form = form,
            onChange = viewModel::updateServerForm,
            onSave = viewModel::saveServerForm,
            onDismiss = viewModel::dismissServerForm,
        )
    }

    // Delete confirm
    state.pendingDeleteServerId?.let {
        AlertDialog(
            onDismissRequest = viewModel::cancelDeleteServer,
            title = { Text("Delete server?") },
            text = { Text("This will remove the MCP server and its tools. This cannot be undone.") },
            confirmButton = {
                TextButton(onClick = viewModel::deleteServer) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = viewModel::cancelDeleteServer) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ServersList(
    servers: List<MCPServer>,
    meta: Map<Int, McpServerUiMeta>,
    onEdit: (MCPServer) -> Unit,
    onDelete: (Int) -> Unit,
    onTest: (Int) -> Unit,
    onToggleEnabled: (MCPServer) -> Unit,
) {
    if (servers.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No MCP servers configured", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(servers, key = { it.id }) { server ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                server.name,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.weight(1f),
                            )
                            Switch(
                                checked = server.enabled,
                                onCheckedChange = { onToggleEnabled(server) },
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            SuggestionChip(onClick = {}, label = { Text(server.transportType.uppercase(), style = MaterialTheme.typography.labelSmall) })
                            SuggestionChip(onClick = {}, label = { Text(server.location.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelSmall) })
                        }
                        val detail = server.url ?: server.command
                        if (detail != null) {
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }

                        // Test result chip
                        meta[server.id]?.testResult?.let { res ->
                            Spacer(Modifier.height(4.dp))
                            val isOk = res.status == "available"
                            Surface(
                                color = if (isOk) MaterialTheme.colorScheme.tertiaryContainer
                                else MaterialTheme.colorScheme.errorContainer,
                                shape = RoundedCornerShape(8.dp),
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Icon(
                                        imageVector = if (isOk) Icons.Default.CheckCircle else Icons.Default.Error,
                                        contentDescription = null,
                                        modifier = Modifier.size(14.dp),
                                    )
                                    Text(
                                        text = if (isOk) "Available (${res.toolCount ?: 0} tools)"
                                        else (res.error ?: "Unavailable"),
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                            }
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                            horizontalArrangement = Arrangement.End,
                        ) {
                            val testing = meta[server.id]?.testing == true
                            IconButton(onClick = { onTest(server.id) }, enabled = !testing) {
                                if (testing) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                else Icon(Icons.Default.PlayArrow, contentDescription = "Test")
                            }
                            IconButton(onClick = { onEdit(server) }) {
                                Icon(Icons.Default.Edit, contentDescription = "Edit")
                            }
                            IconButton(onClick = { onDelete(server.id) }) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun McpServerFormDialog(
    form: McpServerForm,
    onChange: ((McpServerForm) -> McpServerForm) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (form.editingId == null) "Add MCP server" else "Edit MCP server") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = form.name,
                    onValueChange = { v -> onChange { it.copy(name = v) } },
                    label = { Text("Server name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                ExposedDropdown(
                    label = "Transport",
                    options = listOf("sse" to "SSE", "stdio" to "Stdio"),
                    selected = form.transportType,
                    onSelect = { v -> onChange { it.copy(transportType = v) } },
                )

                ExposedDropdown(
                    label = "Location",
                    options = listOf("server" to "External (Server)", "client" to "Internal (This device)"),
                    selected = form.location,
                    onSelect = { v -> onChange { it.copy(location = v) } },
                )

                if (form.transportType == "sse") {
                    OutlinedTextField(
                        value = form.url,
                        onValueChange = { v -> onChange { it.copy(url = v) } },
                        label = { Text("URL") },
                        placeholder = { Text("http://host:port/sse") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = form.command,
                        onValueChange = { v -> onChange { it.copy(command = v) } },
                        label = { Text("Command") },
                        placeholder = { Text("npx or python") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = form.argsText,
                        onValueChange = { v -> onChange { it.copy(argsText = v) } },
                        label = { Text("Arguments (one per line)") },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
                    )
                }

                OutlinedTextField(
                    value = form.envText,
                    onValueChange = { v -> onChange { it.copy(envText = v) } },
                    label = { Text("Environment (KEY=VALUE per line, optional)") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 70.dp),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onSave,
                enabled = form.name.isNotBlank() && !form.saving,
            ) {
                if (form.saving) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                else Text("Save")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExposedDropdown(
    label: String,
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val display = options.firstOrNull { it.first == selected }?.second ?: selected

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
    ) {
        OutlinedTextField(
            value = display,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        onSelect(value)
                        expanded = false
                    },
                )
            }
        }
    }
}

@Composable
private fun ToolsList(builtinTools: List<Tool>, mcpTools: List<Tool>, onToolClick: (Tool) -> Unit) {
    val allTools = builtinTools + mcpTools
    if (allTools.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No tools available", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (builtinTools.isNotEmpty()) {
                item { Text("Built-in", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(bottom = 4.dp)) }
                items(builtinTools) { tool ->
                    ToolCard(tool = tool, onClick = { onToolClick(tool) })
                }
            }
            if (mcpTools.isNotEmpty()) {
                item { Text("MCP", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)) }
                items(mcpTools) { tool ->
                    ToolCard(tool = tool, onClick = { onToolClick(tool) })
                }
            }
        }
    }
}

@Composable
private fun ToolCard(tool: Tool, onClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(tool.function.name, style = MaterialTheme.typography.titleSmall)
            Text(
                tool.function.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
