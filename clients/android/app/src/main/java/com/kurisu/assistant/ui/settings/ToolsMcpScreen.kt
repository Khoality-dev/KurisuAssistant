package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
                0 -> ServersList(state.mcpServers)
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
}

@Composable
private fun ServersList(servers: List<MCPServer>) {
    if (servers.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No MCP servers configured", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(servers, key = { it.id }) { server ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(server.name, style = MaterialTheme.typography.titleSmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            SuggestionChip(onClick = {}, label = { Text(server.transportType.uppercase(), style = MaterialTheme.typography.labelSmall) })
                            SuggestionChip(onClick = {}, label = { Text(server.location.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelSmall) })
                            if (!server.enabled) {
                                SuggestionChip(onClick = {}, label = { Text("Disabled", style = MaterialTheme.typography.labelSmall) })
                            }
                        }
                        val detail = server.url ?: server.command
                        if (detail != null) {
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
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
