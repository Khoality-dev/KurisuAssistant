package com.kurisu.assistant.ui.about

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.ui.update.UpdateDialog

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(
    onBack: () -> Unit,
    viewModel: AboutViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    if (state.updateRelease != null) {
        UpdateDialog(
            release = state.updateRelease!!,
            progress = state.updateProgress,
            apkFile = state.updateApkFile,
            onDownload = viewModel::downloadAndInstall,
            onDismiss = viewModel::dismissUpdate,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("About") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "App: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · wire ${BuildConfig.WIRE_PROTOCOL}",
                style = MaterialTheme.typography.bodyMedium,
            )
            val backend = state.backendVersion
            val backendWire = state.backendWireProtocol
            if (backend != null && backendWire != null) {
                Text(
                    "Backend: $backend · wire $backendWire",
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                Text(
                    "Backend: unreachable",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(
                onClick = viewModel::checkForUpdate,
                enabled = !state.isCheckingUpdate,
            ) {
                if (state.isCheckingUpdate) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                }
                Text("Check for updates")
            }
        }
    }
}
