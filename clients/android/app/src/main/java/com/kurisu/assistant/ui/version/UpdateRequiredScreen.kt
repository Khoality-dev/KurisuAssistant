package com.kurisu.assistant.ui.version

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.ServerVersionInfo

/** Hard gate shown on wire-protocol mismatch — user must update before proceeding. */
@Composable
fun UpdateRequiredScreen(
    info: ServerVersionInfo,
    onCheckForUpdate: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp)) {
        Column(
            modifier = Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Update required",
                style = MaterialTheme.typography.headlineSmall,
            )
            Text(
                "This app is incompatible with the server. Please update.",
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                "App: ${BuildConfig.VERSION_NAME} (wire ${BuildConfig.WIRE_PROTOCOL})",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "Server: ${info.backendVersion} (wire ${info.wireProtocol})",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onCheckForUpdate) { Text("Check for updates") }
        }
    }
}

@Composable
fun VersionCheckPlaceholder() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(48.dp))
    }
}
