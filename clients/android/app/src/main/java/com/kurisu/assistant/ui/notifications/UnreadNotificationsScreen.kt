package com.kurisu.assistant.ui.notifications

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.domain.notifications.NotificationTarget
import com.kurisu.assistant.domain.notifications.notificationHeading

/** What is unread, from the bell (#353): the server's list; reading here reads everywhere. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnreadNotificationsScreen(
    onBack: () -> Unit,
    onOpenTarget: (NotificationTarget) -> Unit,
    viewModel: UnreadNotificationsViewModel = hiltViewModel(),
) {
    val unread by viewModel.unread.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Unread") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (unread.isNotEmpty()) TextButton(onClick = viewModel::markAllRead) { Text("Mark all read") }
                },
            )
        },
    ) { padding ->
        if (unread.isEmpty()) {
            Text(
                "Nothing unread",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(padding).padding(16.dp),
            )
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
                itemsIndexed(unread, key = { _, n -> n.id }) { index, notification ->
                    if (index > 0) HorizontalDivider()
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenTarget(viewModel.open(notification)) }
                            .padding(16.dp),
                    ) {
                        Text(notificationHeading(notification), style = MaterialTheme.typography.titleSmall)
                        if (notification.body.isNotEmpty()) {
                            Text(
                                notification.body,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
