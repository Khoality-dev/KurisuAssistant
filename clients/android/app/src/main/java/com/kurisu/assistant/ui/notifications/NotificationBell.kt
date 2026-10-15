package com.kurisu.assistant.ui.notifications

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel

/**
 * The bell on the Chats screen's top bar — the first screen after sign-in
 * (#353). The badge is the server's unread count, so one read on the desktop
 * clears here too; a tap opens the unread list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationBell(
    onClick: () -> Unit,
    viewModel: UnreadNotificationsViewModel = hiltViewModel(),
) {
    val count by viewModel.unreadCount.collectAsState()
    val label = if (count > 0) "Notifications, $count unread" else "Notifications"
    IconButton(onClick = onClick) {
        BadgedBox(badge = { if (count > 0) Badge { Text(if (count > 99) "99+" else "$count") } }) {
            Icon(Icons.Outlined.NotificationsNone, contentDescription = label)
        }
    }
}
