package com.kurisu.assistant.ui.update

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.kurisu.assistant.data.model.GithubRelease
import java.io.File

@Composable
fun UpdateDialog(
    release: GithubRelease,
    progress: Float?,
    apkFile: File?,
    onDownload: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val apkAsset = release.assets.firstOrNull { it.name.endsWith(".apk") }
    val fileSizeMb = apkAsset?.let { "%.1f MB".format(it.size / 1_048_576.0) }

    AlertDialog(
        onDismissRequest = { if (progress == null) onDismiss() },
        title = { Text(release.name ?: release.tagName) },
        text = {
            Column {
                if (fileSizeMb != null) {
                    Text(
                        text = "Size: $fileSizeMb",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                }

                if (progress != null && apkFile == null) {
                    Text("Downloading...", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "${(progress * 100).toInt()}%",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (!release.body.isNullOrBlank() && progress == null) {
                    Text(
                        text = "Changelog",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Spacer(Modifier.height(4.dp))
                    Box(modifier = Modifier.heightIn(max = 200.dp)) {
                        Text(
                            text = release.body,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.verticalScroll(rememberScrollState()),
                        )
                    }
                }
            }
        },
        confirmButton = {
            when {
                apkFile != null -> {
                    Button(onClick = { installApk(context, apkFile) }) {
                        Text("Install")
                    }
                }
                progress != null -> {
                    Button(onClick = {}, enabled = false) {
                        Text("Downloading...")
                    }
                }
                else -> {
                    Button(onClick = onDownload) {
                        Text("Update")
                    }
                }
            }
        },
        dismissButton = {
            if (progress == null) {
                TextButton(onClick = onDismiss) {
                    Text("Later")
                }
            }
        },
    )
}

