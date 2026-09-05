package com.kurisu.assistant.ui.navigation

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.TheaterComedy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.launch

/**
 * The app's five destinations, in the order the design lists them.
 *
 * The drawer is hosted here rather than inside a screen because two screens
 * (Chats and Chat) open it and both must show the same list with the same
 * selection. [route] is a [Routes] constant.
 */
private data class DrawerEntry(
    val route: String,
    val label: String,
    val icon: ImageVector,
)

private val DrawerEntries = listOf(
    DrawerEntry(Routes.CONVERSATIONS, "Chats", Icons.Outlined.Forum),
    DrawerEntry(Routes.ASSISTANT, "Assistant", Icons.Outlined.SmartToy),
    DrawerEntry(Routes.PERSONAS, "Personas", Icons.Outlined.TheaterComedy),
    DrawerEntry(Routes.TOOLS_MCP, "Tools & MCP", Icons.Outlined.Build),
    DrawerEntry(Routes.SKILLS, "Skills", Icons.Outlined.AutoFixHigh),
)

/**
 * Wraps [content] in the app drawer and hands it the callback that opens it.
 *
 * [currentRoute] only drives the selected highlight; a screen reached from a
 * drawer row but not itself a drawer row (Settings, say) simply highlights
 * nothing.
 */
@Composable
fun AppDrawerHost(
    currentRoute: String,
    onNavigate: (route: String) -> Unit,
    onLoggedOut: () -> Unit,
    viewModel: AppDrawerViewModel = hiltViewModel(),
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var showLogoutDialog by remember { mutableStateOf(false) }

    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = { Text("Logout") },
            text = { Text("Are you sure you want to logout?") },
            confirmButton = {
                TextButton(onClick = {
                    showLogoutDialog = false
                    viewModel.logout(onLoggedOut)
                }) { Text("Logout") }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutDialog = false }) { Text("Cancel") }
            },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(modifier = Modifier.width(280.dp)) {
                Spacer(Modifier.height(16.dp))
                Text(
                    text = "Kurisu",
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                DrawerEntries.forEach { entry ->
                    NavigationDrawerItem(
                        icon = { Icon(entry.icon, contentDescription = null) },
                        label = { Text(entry.label) },
                        selected = entry.route == currentRoute,
                        onClick = {
                            scope.launch { drawerState.close() }
                            onNavigate(entry.route)
                        },
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }

                Spacer(Modifier.weight(1f))
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                NavigationDrawerItem(
                    icon = { Icon(Icons.Outlined.Settings, contentDescription = null) },
                    label = { Text("Settings") },
                    selected = false,
                    onClick = {
                        scope.launch { drawerState.close() }
                        onNavigate(Routes.SETTINGS)
                    },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                NavigationDrawerItem(
                    icon = { Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null) },
                    label = { Text("Logout") },
                    selected = false,
                    onClick = {
                        scope.launch { drawerState.close() }
                        showLogoutDialog = true
                    },
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Spacer(Modifier.height(16.dp))
            }
        },
    ) {
        content { scope.launch { drawerState.open() } }
    }
}
