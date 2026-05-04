package com.kurisu.assistant.ui.common

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.data.model.ModelInfo

/**
 * Read-only model picker with a refresh button.
 *
 * Replaces the ad-hoc ExposedDropdownMenu blocks that used to live in
 * AgentsScreen and AccountScreen, which had three bugs in common:
 *  1. The text field accepted arbitrary input (no readOnly).
 *  2. The menu was gated on `availableModels.isNotEmpty()`, so when the
 *     list hadn't loaded yet, tapping the chevron rendered nothing.
 *  3. There was no way to refresh the list after the backend pulled new
 *     models — users had to restart the app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelDropdown(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    availableModels: List<ModelInfo>,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    supportingText: @Composable (() -> Unit)? = null,
) {
    var expanded by remember { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        ExposedDropdownMenuBox(
            expanded = expanded,
            onExpandedChange = { expanded = it },
            modifier = Modifier.weight(1f),
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = {},
                readOnly = true,
                label = { Text(label) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().menuAnchor(),
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                supportingText = supportingText,
            )
            ExposedDropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
                if (availableModels.isEmpty()) {
                    DropdownMenuItem(
                        enabled = false,
                        text = {
                            Text(
                                if (isRefreshing) "Loading models…" else "No models — tap refresh",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                        onClick = {},
                    )
                } else {
                    val grouped = availableModels.groupBy { it.provider }.toSortedMap()
                    grouped.forEach { (provider, models) ->
                        DropdownMenuItem(
                            enabled = false,
                            text = {
                                Text(
                                    provider.uppercase(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            },
                            onClick = {},
                        )
                        models.sortedBy { it.name }.forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model.name) },
                                onClick = {
                                    onValueChange(model.name)
                                    expanded = false
                                },
                            )
                        }
                    }
                }
            }
        }

        IconButton(
            onClick = onRefresh,
            enabled = !isRefreshing,
            modifier = Modifier.padding(top = 4.dp),
        ) {
            if (isRefreshing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                )
            } else {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh models")
            }
        }
    }
}
