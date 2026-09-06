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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.ServerVersionInfo

/**
 * Hard gate shown on wire-protocol mismatch. It says which side to update, and
 * it is not a dead end: "Change server" signs out and returns to the login
 * form, where the stored URL is editable (#150) — the stored URL is the one
 * thing a user who mistyped it needs to reach.
 */
@Composable
fun UpdateRequiredScreen(
    info: ServerVersionInfo,
    onCheckForUpdate: () -> Unit,
    onChangeServer: () -> Unit,
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
                UpdateRequiredCopy.explain(BuildConfig.WIRE_PROTOCOL, info.wireProtocol),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
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
            OutlinedButton(onClick = onChangeServer) { Text("Change server") }
        }
    }
}

@Composable
fun VersionCheckPlaceholder() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(48.dp))
    }
}
