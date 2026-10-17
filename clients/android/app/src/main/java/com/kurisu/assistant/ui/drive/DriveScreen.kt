package com.kurisu.assistant.ui.drive

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AudioFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.model.PermissionMode
import com.kurisu.assistant.domain.drive.DriveFormat
import com.kurisu.assistant.domain.drive.DriveTransfer
import com.kurisu.assistant.domain.drive.TransferDirection
import com.kurisu.assistant.domain.drive.TransferStatus
import com.kurisu.assistant.ui.chat.PermissionModeSheet
import java.time.ZonedDateTime

/**
 * Kurisu Drive (#175): the account's files on the server, browsed a folder at a
 * time. Tap a folder to go in, a file to open it in another app; a row's menu
 * saves it to the phone, shares, renames, moves or deletes it; + uploads files
 * from the phone or makes a folder. Transfers run on after the screen is left,
 * and the strip at the bottom says how far the current one has got.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DriveScreen(
    onOpenMenu: (() -> Unit)? = null,
    viewModel: DriveViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val transfers by viewModel.transferList.collectAsState()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }

    var menuOpen by remember { mutableStateOf(false) }
    var addOpen by remember { mutableStateOf(false) }
    var transfersOpen by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf<DriveNode?>(null) }

    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        viewModel.upload(uris.map(Uri::toString))
    }
    val saveFile = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val node = saving
        saving = null
        if (uri != null && node != null) viewModel.saveToPhone(node, uri.toString())
    }

    LaunchedEffect(Unit) {
        viewModel.events.collect { event ->
            val intent = when (event) {
                is DriveEvent.View -> Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(event.uri), event.mime)
                is DriveEvent.Share -> Intent.createChooser(
                    Intent(Intent.ACTION_SEND).setType(event.mime).putExtra(Intent.EXTRA_STREAM, Uri.parse(event.uri))
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                    null,
                )
            }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                context.startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                snackbar.showSnackbar("No app on this phone opens this file. Save it to the phone instead.")
            }
        }
    }
    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }

    BackHandler(enabled = !state.atRoot) { viewModel.up() }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(state.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = {
                        if (onOpenMenu != null) {
                            IconButton(onClick = onOpenMenu) { Icon(Icons.Outlined.Menu, contentDescription = "Menu") }
                        }
                    },
                    actions = {
                        Box {
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More") }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text("New folder") },
                                    onClick = { menuOpen = false; viewModel.showNewFolder() },
                                )
                                if (transfers.isNotEmpty()) {
                                    DropdownMenuItem(
                                        text = { Text("Transfers") },
                                        onClick = { menuOpen = false; transfersOpen = true },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text("Refresh") },
                                    onClick = { menuOpen = false; viewModel.refresh() },
                                )
                            }
                        }
                    },
                )
                if (!state.atRoot) PathRow(state.path, onGoTo = viewModel::goTo, tag = "drive-path")
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            AddButton(
                open = addOpen,
                onToggle = { addOpen = !addOpen },
                onUpload = { addOpen = false; pickFiles.launch(arrayOf("*/*")) },
                onNewFolder = { addOpen = false; viewModel.showNewFolder() },
            )
        },
        bottomBar = {
            val current = transfers.firstOrNull { it.status == TransferStatus.ACTIVE }
                ?: transfers.firstOrNull { it.status == TransferStatus.WAITING }
            if (current != null) {
                val more = transfers.count { !it.isFinished } - 1
                TransferStrip(current, more, onStop = { viewModel.stopTransfer(current.id) }, onOpen = { transfersOpen = true })
            }
        },
    ) { padding ->
        val now = remember(state.nodes) { ZonedDateTime.now() }
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize().testTag("drive-list"),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            if (state.atRoot) {
                state.usage?.let { usage ->
                    item(key = "storage") {
                        StorageCard(usage, state.permissionMode, onAccess = viewModel::showPermissionMode)
                    }
                }
            }
            state.error?.let { error ->
                item(key = "error") {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                        TextButton(onClick = viewModel::refresh) { Text("Retry") }
                    }
                }
            }
            if (state.isLoading && state.nodes.isEmpty()) {
                item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
            } else if (state.nodes.isEmpty() && state.error == null) {
                item(key = "empty") { EmptyFolder() }
            }
            items(state.nodes, key = { it.id }) { node ->
                NodeRow(
                    node = node,
                    meta = DriveFormat.rowMeta(node, now),
                    onOpen = { viewModel.open(node) },
                    onSave = {
                        saving = node
                        saveFile.launch(node.name)
                    },
                    onShare = { viewModel.share(node) },
                    onRename = { viewModel.startRename(node) },
                    onMove = { viewModel.startMove(node) },
                    onDelete = { viewModel.startDelete(node) },
                )
            }
        }
    }

    when (val dialog = state.dialog) {
        is DriveDialog.NewFolder -> NameDialog(
            title = "New folder",
            initial = "",
            confirm = "Create",
            error = dialog.error,
            onConfirm = viewModel::createFolder,
            onDismiss = viewModel::dismissDialog,
        )
        is DriveDialog.Rename -> NameDialog(
            title = "Rename",
            initial = dialog.node.name,
            confirm = "Save",
            error = dialog.error,
            onConfirm = viewModel::rename,
            onDismiss = viewModel::dismissDialog,
        )
        is DriveDialog.Delete -> DeleteDialog(dialog.node, onConfirm = viewModel::confirmDelete, onDismiss = viewModel::dismissDialog)
        is DriveDialog.Conflict -> ConflictDialog(dialog, onAnswer = viewModel::resolveConflict, onDismiss = viewModel::dismissDialog)
        DriveDialog.PermissionModePicker -> PermissionModeSheet(
            current = state.permissionMode ?: PermissionMode.ASK,
            onPick = viewModel::setPermissionMode,
            onDismiss = viewModel::dismissDialog,
        )
        null -> {}
    }

    state.move?.let { move ->
        MoveSheet(
            move = move,
            onInto = viewModel::moveInto,
            onGoTo = viewModel::moveGoTo,
            onMoveHere = viewModel::moveHere,
            onDismiss = viewModel::cancelMove,
        )
    }

    if (transfersOpen) {
        TransfersSheet(
            transfers = transfers,
            onStop = viewModel::stopTransfer,
            onOpen = viewModel::openTransfer,
            onClearFinished = viewModel::clearFinishedTransfers,
            onDismiss = { transfersOpen = false },
        )
    }

    // A sheet left open over an empty list of transfers says nothing.
    LaunchedEffect(transfers.isEmpty()) {
        if (transfers.isEmpty()) transfersOpen = false
    }
}

/** "Drive › Reports › 2026": tap any folder on the way to go back to it. */
@Composable
private fun PathRow(path: List<DriveCrumb>, onGoTo: (Int) -> Unit, tag: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp)
            .padding(bottom = 4.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        path.forEachIndexed { index, crumb ->
            if (index > 0) {
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (index == path.lastIndex) {
                Text(
                    crumb.name,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                )
            } else {
                TextButton(onClick = { onGoTo(index) }) { Text(crumb.name, style = MaterialTheme.typography.labelLarge) }
            }
        }
    }
}

@Composable
private fun StorageCard(usage: DriveUsage, mode: PermissionMode?, onAccess: () -> Unit) {
    val fraction = if (usage.quotaBytes > 0) (usage.usedBytes.toFloat() / usage.quotaBytes).coerceIn(0f, 1f) else 0f
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Storage", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                Text(DriveFormat.usageLine(usage), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)),
                color = if (fraction > 0.9f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            Text(DriveFormat.usageDetail(usage), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (mode != null) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClickLabel = "Change the permission mode", onClick = onAccess)
                        .heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Outlined.Shield, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Column(Modifier.weight(1f)) {
                        Text("Assistant access", style = MaterialTheme.typography.labelLarge)
                        Text(
                            DriveFormat.assistantAccess(mode),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

private data class NodeLook(val icon: ImageVector, val bg: Color, val fg: Color)

@Composable
private fun lookOf(node: DriveNode): NodeLook {
    val scheme = MaterialTheme.colorScheme
    val mime = node.mime.orEmpty()
    return when {
        node.isDir -> NodeLook(Icons.Outlined.Folder, scheme.primaryContainer, scheme.onPrimaryContainer)
        mime.startsWith("image/") -> NodeLook(Icons.Outlined.Image, scheme.tertiaryContainer, scheme.onTertiaryContainer)
        mime.startsWith("audio/") -> NodeLook(Icons.Outlined.AudioFile, scheme.secondaryContainer, scheme.onSecondaryContainer)
        mime.startsWith("video/") -> NodeLook(Icons.Outlined.Movie, scheme.secondaryContainer, scheme.onSecondaryContainer)
        mime.startsWith("text/") || mime == "application/pdf" || mime == "application/json" ->
            NodeLook(Icons.Outlined.Description, scheme.surfaceContainerHighest, scheme.onSurfaceVariant)
        else -> NodeLook(Icons.AutoMirrored.Outlined.InsertDriveFile, scheme.surfaceContainerHighest, scheme.onSurfaceVariant)
    }
}

@Composable
private fun NodeRow(
    node: DriveNode,
    meta: String,
    onOpen: () -> Unit,
    onSave: () -> Unit,
    onShare: () -> Unit,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val look = lookOf(node)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = if (node.isDir) "Open folder" else "Open", onClick = onOpen)
            .heightIn(min = 64.dp)
            .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(look.bg),
            contentAlignment = Alignment.Center,
        ) {
            Icon(look.icon, contentDescription = null, tint = look.fg, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(node.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) {
                Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(Icons.Outlined.MoreVert, contentDescription = "More for ${node.name}")
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                fun pick(action: () -> Unit) {
                    menuOpen = false
                    action()
                }
                if (!node.isDir) {
                    DropdownMenuItem(
                        text = { Text("Save to phone") },
                        leadingIcon = { Icon(Icons.Outlined.Download, contentDescription = null) },
                        onClick = { pick(onSave) },
                    )
                    DropdownMenuItem(
                        text = { Text("Share") },
                        leadingIcon = { Icon(Icons.Outlined.Share, contentDescription = null) },
                        onClick = { pick(onShare) },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Rename") },
                    leadingIcon = { Icon(Icons.Outlined.DriveFileRenameOutline, contentDescription = null) },
                    onClick = { pick(onRename) },
                )
                DropdownMenuItem(
                    text = { Text("Move") },
                    leadingIcon = { Icon(Icons.Outlined.DriveFileMove, contentDescription = null) },
                    onClick = { pick(onMove) },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = { pick(onDelete) },
                )
            }
        }
    }
}

@Composable
private fun EmptyFolder() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 48.dp, vertical = 64.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(72.dp).clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Folder, contentDescription = null, modifier = Modifier.size(34.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("Nothing here yet", style = MaterialTheme.typography.titleMedium)
        Text(
            "Files you upload from this phone, and files the assistant saves here, show up in this folder.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

/**
 * + opens into Upload files and New folder. Plain buttons rather than extended
 * FABs: an extended FAB hides its label from the merged semantics tree.
 */
@Composable
private fun AddButton(open: Boolean, onToggle: () -> Unit, onUpload: () -> Unit, onNewFolder: () -> Unit) {
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (open) {
            Button(onClick = onUpload, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.Upload, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("Upload files")
            }
            Button(onClick = onNewFolder, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.CreateNewFolder, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("New folder")
            }
        }
        FloatingActionButton(onClick = onToggle) {
            Icon(if (open) Icons.Outlined.Close else Icons.Outlined.Add, contentDescription = if (open) "Close" else "Add")
        }
    }
}

@Composable
private fun TransferStrip(transfer: DriveTransfer, more: Int, onStop: () -> Unit, onOpen: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 2.dp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 12.dp)
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClickLabel = "Show transfers", onClick = onOpen),
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(
                if (transfer.direction == TransferDirection.UP) Icons.Outlined.Upload else Icons.Outlined.Download,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        transfer.name,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        stripNote(transfer, more),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val progress = transfer.progress
                if (transfer.status == TransferStatus.ACTIVE && progress != null) {
                    LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            }
            IconButton(onClick = onStop) {
                Icon(Icons.Outlined.Close, contentDescription = "Stop ${transfer.name}")
            }
        }
    }
}

private fun stripNote(transfer: DriveTransfer, more: Int): String {
    val head = when {
        transfer.status == TransferStatus.WAITING -> "Waiting"
        transfer.progress != null -> "${(transfer.progress!! * 100).toInt()}%"
        else -> DriveFormat.bytes(transfer.transferredBytes)
    }
    return if (more > 0) "$head · $more more" else head
}

private fun transferNote(transfer: DriveTransfer): String = when (transfer.status) {
    TransferStatus.WAITING -> "Waiting" + (transfer.totalBytes?.let { " · ${DriveFormat.bytes(it)}" } ?: "")
    TransferStatus.ACTIVE -> {
        val verb = if (transfer.direction == TransferDirection.UP) "Uploading to ${transfer.place}" else "Downloading"
        val sizes = transfer.totalBytes?.let { "${DriveFormat.bytes(transfer.transferredBytes)} of ${DriveFormat.bytes(it)}" }
            ?: DriveFormat.bytes(transfer.transferredBytes)
        "$verb · $sizes"
    }
    TransferStatus.DONE -> if (transfer.direction == TransferDirection.UP) "Uploaded to ${transfer.place}" else "Saved to ${transfer.place}"
    TransferStatus.FAILED -> transfer.error ?: "Failed"
    TransferStatus.STOPPED -> "Stopped"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TransfersSheet(
    transfers: List<DriveTransfer>,
    onStop: (Long) -> Unit,
    onOpen: (DriveTransfer) -> Unit,
    onClearFinished: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Transfers", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (transfers.any { it.isFinished }) TextButton(onClick = onClearFinished) { Text("Clear finished") }
            }
            transfers.forEach { t ->
                val failed = t.status == TransferStatus.FAILED
                Row(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 24.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    val (bg, fg) = when (t.status) {
                        TransferStatus.FAILED -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
                        TransferStatus.DONE -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
                        else -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
                    }
                    Box(Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(bg), contentAlignment = Alignment.Center) {
                        Icon(
                            when {
                                failed -> Icons.Outlined.ErrorOutline
                                t.direction == TransferDirection.UP -> Icons.Outlined.Upload
                                else -> Icons.Outlined.Download
                            },
                            contentDescription = null,
                            tint = fg,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(t.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val progress = t.progress
                        if (t.status == TransferStatus.ACTIVE && progress != null) {
                            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                        }
                        Text(
                            transferNote(t),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (t.status == TransferStatus.DONE && t.resultUri != null && t.direction == TransferDirection.DOWN) {
                        OutlinedButton(onClick = { onOpen(t) }) { Text("Open") }
                    }
                    if (!t.isFinished) {
                        IconButton(onClick = { onStop(t.id) }) { Icon(Icons.Outlined.Close, contentDescription = "Stop ${t.name}") }
                    }
                }
            }
        }
    }
}

@Composable
private fun NameDialog(
    title: String,
    initial: String,
    confirm: String,
    error: String?,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // The name is selected up to its extension, so typing replaces just the name.
    val stemEnd = initial.lastIndexOf('.').takeIf { it > 0 } ?: initial.length
    var value by remember(initial) { mutableStateOf(TextFieldValue(initial, selection = TextRange(0, stemEnd))) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                label = { Text("Name") },
                singleLine = true,
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(value.text) }, enabled = value.text.isNotBlank()) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeleteDialog(node: DriveNode, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
        title = { Text("Delete ${node.name}?") },
        text = {
            Text(
                if (node.isDir) {
                    "The folder and everything in it are deleted for good, on every device. The drive has no trash."
                } else {
                    "It is deleted for good, on every device. The drive has no trash."
                },
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ConflictDialog(dialog: DriveDialog.Conflict, onAnswer: (ConflictChoice, Boolean) -> Unit, onDismiss: () -> Unit) {
    var forTheOthers by remember(dialog) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${dialog.name} is already here") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Replace the copy in ${dialog.place}, or keep both and save this one as ${dialog.keepBothName}.")
                if (dialog.others > 0) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { forTheOthers = !forTheOthers }
                            .heightIn(min = 48.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = forTheOthers, onCheckedChange = { forTheOthers = it })
                        Text(if (dialog.others == 1) "Do the same for the other file" else "Do the same for the other ${dialog.others} files")
                    }
                }
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onAnswer(ConflictChoice.SKIP, forTheOthers) }) { Text("Skip") }
                TextButton(onClick = { onAnswer(ConflictChoice.KEEP_BOTH, forTheOthers) }) { Text("Keep both") }
                TextButton(onClick = { onAnswer(ConflictChoice.REPLACE, forTheOthers) }) { Text("Replace") }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MoveSheet(
    move: DriveMoveState,
    onInto: (DriveNode) -> Unit,
    onGoTo: (Int) -> Unit,
    onMoveHere: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("drive-move-sheet"),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            Text(
                "Move ${move.node.name}",
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
            PathRow(move.path, onGoTo = onGoTo, tag = "drive-move-path")
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Column(Modifier.heightIn(min = 160.dp)) {
                when {
                    move.isLoading -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    move.folders.isEmpty() -> Text(
                        "No folders in here",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(24.dp),
                    )
                    else -> move.folders.forEach { folder ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(onClickLabel = "Open folder") { onInto(folder) }
                                .heightIn(min = 56.dp)
                                .padding(horizontal = 24.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            Box(
                                Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primaryContainer),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(Icons.Outlined.Folder, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                            }
                            Text(folder.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            Icon(
                                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            move.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Spacer(Modifier.width(8.dp))
                Button(onClick = onMoveHere, enabled = move.canMoveHere) {
                    Text("Move here", fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}
