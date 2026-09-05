package com.kurisu.assistant.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Face
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.ui.theme.KurisuTheme
import com.kurisu.assistant.ui.update.UpdateDialog

/**
 * The settings index: grouped rows of icon, label and sub-label.
 *
 * Every row that edits something opens the screen that owns it. The two rows
 * that decide something here — auto-update and the manual check — do it inline,
 * because there is no screen behind them.
 *
 * The design draws Text-to-Speech and Speech Recognition as two rows. This
 * client has one screen holding both (plus the microphone device), so they are
 * one row: two rows leading to the same place would say there are two places.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onNavigateToAccount: () -> Unit,
    onNavigateToAppearance: () -> Unit,
    onNavigateToTtsAsr: () -> Unit,
    onNavigateToFaces: () -> Unit,
    onNavigateToAbout: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(state.message) {
        state.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    state.updateRelease?.let { release ->
        UpdateDialog(
            release = release,
            progress = state.updateProgress,
            apkFile = state.updateApkFile,
            onDownload = viewModel::downloadAndInstall,
            onDismiss = viewModel::dismissUpdate,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
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
                .verticalScroll(rememberScrollState()),
        ) {
            GroupLabel("You")
            SettingsRow(
                icon = Icons.Outlined.AccountCircle,
                label = "Account",
                sub = "Preferred name, Ollama URL, server",
                onClick = onNavigateToAccount,
            )
            SettingsRow(
                icon = Icons.Outlined.Palette,
                label = "Appearance",
                sub = "Theme mode",
                onClick = onNavigateToAppearance,
            )

            GroupLabel("Voice")
            SettingsRow(
                icon = Icons.Outlined.RecordVoiceOver,
                label = "Text-to-Speech & ASR",
                sub = "Backend, voice, language, mic device",
                onClick = onNavigateToTtsAsr,
            )
            SettingsRow(
                icon = Icons.Outlined.Face,
                label = "Face Identities",
                sub = state.faceCount?.let {
                    if (it == 1) "1 person enrolled" else "$it people enrolled"
                } ?: "People the camera recognises",
                onClick = onNavigateToFaces,
            )

            GroupLabel("App")
            SettingsRow(
                icon = Icons.Outlined.SystemUpdate,
                label = "Auto-update",
                sub = if (state.autoUpdate) {
                    "On · checks GitHub Releases"
                } else {
                    "Off · check for updates below"
                },
                onClick = { viewModel.setAutoUpdate(!state.autoUpdate) },
                trailing = {
                    Switch(
                        checked = state.autoUpdate,
                        onCheckedChange = viewModel::setAutoUpdate,
                    )
                },
            )
            SettingsRow(
                icon = Icons.Outlined.SystemUpdate,
                label = "Check for updates",
                sub = state.updateStatus ?: "v${BuildConfig.VERSION_NAME} (${BuildConfig.FLAVOR})",
                onClick = viewModel::checkForUpdate,
                trailing = if (state.isCheckingUpdate) {
                    {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                } else {
                    null
                },
            )
            SettingsRow(
                icon = Icons.Outlined.Info,
                label = "About",
                sub = "v${BuildConfig.VERSION_NAME} (${BuildConfig.FLAVOR}) · wire ${BuildConfig.WIRE_PROTOCOL}",
                onClick = onNavigateToAbout,
            )

            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun GroupLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = KurisuTheme.extraTypography.metadataSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 6.dp),
    )
}

/**
 * One settings row. [trailing] replaces the chevron when the row does something
 * in place rather than opening a screen — a switch, or a spinner while a check
 * is running.
 */
@Composable
private fun SettingsRow(
    icon: ImageVector,
    label: String,
    sub: String,
    onClick: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(21.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                sub,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (trailing != null) {
            Box(contentAlignment = Alignment.Center) { trailing() }
        } else {
            Icon(
                Icons.Outlined.ChevronRight,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
