package com.kurisu.assistant.ui.faces

import android.Manifest
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.kurisu.assistant.data.model.FaceIdentity
import com.kurisu.assistant.data.model.FacePhoto
import java.io.File
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FaceIdentitiesScreen(
    onBack: () -> Unit,
    viewModel: FaceIdentitiesViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val context = LocalContext.current

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Face Identities") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::loadIdentities) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = viewModel::openCreateDialog) {
                Icon(Icons.Default.Add, contentDescription = "Add identity")
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (state.isLoading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else if (state.identities.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No face identities. Tap + to add one.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.identities, key = { it.id }) { identity ->
                        IdentityCard(
                            identity = identity,
                            onClick = { viewModel.openDetail(identity.id) },
                            onDelete = { viewModel.confirmDeleteIdentity(identity.id) },
                        )
                    }
                }
            }
        }
    }

    if (state.showCreateDialog) {
        CreateIdentityDialog(
            name = state.createName,
            photoPath = state.createPhotoPath,
            creating = state.creating,
            onNameChange = viewModel::setCreateName,
            onPhotoChange = viewModel::setCreatePhoto,
            onSubmit = viewModel::submitCreate,
            onDismiss = viewModel::dismissCreateDialog,
        )
    }

    state.detail?.let { detail ->
        IdentityDetailDialog(
            detail = detail,
            baseUrl = state.baseUrl,
            onDismiss = viewModel::dismissDetail,
            onAddPhoto = viewModel::addPhotoToCurrent,
            onDeletePhoto = viewModel::deletePhoto,
            onDeleteIdentity = { viewModel.confirmDeleteIdentity(detail.id) },
        )
    }

    state.pendingDeleteIdentityId?.let { id ->
        val target = state.identities.find { it.id == id }
        AlertDialog(
            onDismissRequest = viewModel::cancelDeleteIdentity,
            title = { Text("Delete identity?") },
            text = {
                Text("This will remove ${target?.name ?: "this identity"} and all associated photos. This cannot be undone.")
            },
            confirmButton = {
                TextButton(onClick = viewModel::deleteIdentity) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = viewModel::cancelDeleteIdentity) { Text("Cancel") } },
        )
    }
}

@Composable
private fun IdentityCard(
    identity: FaceIdentity,
    onClick: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = identity.name.firstOrNull()?.uppercase() ?: "?",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(identity.name, style = MaterialTheme.typography.titleSmall)
                Text(
                    "${identity.photoCount} photo${if (identity.photoCount == 1) "" else "s"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun CreateIdentityDialog(
    name: String,
    photoPath: String?,
    creating: Boolean,
    onNameChange: (String) -> Unit,
    onPhotoChange: (String?) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val captureLauncher = rememberCameraCaptureLauncher { result ->
        onPhotoChange(result?.path)
    }
    val cameraPermissionLauncher = rememberCameraPermissionLauncher(captureLauncher)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New face identity") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = onNameChange,
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                if (photoPath != null) {
                    AsyncImage(
                        model = ImageRequest.Builder(context).data(File(photoPath)).build(),
                        contentDescription = "Captured photo",
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(160.dp)
                            .clip(RoundedCornerShape(8.dp)),
                        contentScale = ContentScale.Crop,
                    )
                }

                OutlinedButton(
                    onClick = { cameraPermissionLauncher() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (photoPath == null) "Capture photo" else "Retake photo")
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onSubmit,
                enabled = name.isNotBlank() && photoPath != null && !creating,
            ) {
                if (creating) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                else Text("Create")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun IdentityDetailDialog(
    detail: com.kurisu.assistant.data.model.FaceIdentityDetail,
    baseUrl: String,
    onDismiss: () -> Unit,
    onAddPhoto: (String) -> Unit,
    onDeletePhoto: (Int) -> Unit,
    onDeleteIdentity: () -> Unit,
) {
    val captureLauncher = rememberCameraCaptureLauncher { result ->
        result?.path?.let(onAddPhoto)
    }
    val cameraPermissionLauncher = rememberCameraPermissionLauncher(captureLauncher)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${detail.name} – ${detail.photos.size} photo${if (detail.photos.size == 1) "" else "s"}") },
        text = {
            Column {
                if (detail.photos.isEmpty()) {
                    Text("No photos yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(3),
                        modifier = Modifier.heightIn(max = 320.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(detail.photos, key = { it.id }) { photo ->
                            FacePhotoTile(
                                photo = photo,
                                baseUrl = baseUrl,
                                onDelete = { onDeletePhoto(photo.id) },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { cameraPermissionLauncher() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.PhotoCamera, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Add photo")
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        dismissButton = {
            TextButton(onClick = onDeleteIdentity) {
                Text("Delete identity", color = MaterialTheme.colorScheme.error)
            }
        },
    )
}

@Composable
private fun FacePhotoTile(
    photo: FacePhoto,
    baseUrl: String,
    onDelete: () -> Unit,
) {
    val url = if (photo.url.startsWith("http")) photo.url
    else "${baseUrl.trimEnd('/')}/images/${photo.photoUuid}"

    Box(modifier = Modifier.size(96.dp)) {
        AsyncImage(
            model = url,
            contentDescription = "Face photo",
            modifier = Modifier
                .matchParentSize()
                .clip(RoundedCornerShape(6.dp)),
            contentScale = ContentScale.Crop,
        )
        Icon(
            imageVector = Icons.Default.Close,
            contentDescription = "Delete photo",
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(2.dp)
                .size(20.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.error)
                .padding(2.dp)
                .clickable(onClick = onDelete),
            tint = MaterialTheme.colorScheme.onError,
        )
    }
}

// ── Camera plumbing ────────────────────────────────────────────────────────

/**
 * Launches the system camera to capture a photo into a cache file. Calls back with the
 * captured file's absolute path on success, or null on failure/cancel.
 */
@Composable
private fun rememberCameraCaptureLauncher(
    onResult: (FacePhotoCapture?) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    var pendingFile by remember { mutableStateOf<File?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val f = pendingFile
        pendingFile = null
        if (success && f != null && f.length() > 0) {
            onResult(FacePhotoCapture(uri = Uri.fromFile(f), path = f.absolutePath))
        } else {
            onResult(null)
        }
    }
    return {
        val (uri, file) = createFacePhotoUri(context)
        pendingFile = file
        launcher.launch(uri)
    }
}

private data class FacePhotoCapture(val uri: Uri, val path: String)

@Composable
private fun rememberCameraPermissionLauncher(invokeCapture: () -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) invokeCapture()
    }
    return { launcher.launch(Manifest.permission.CAMERA) }
}

private fun createFacePhotoUri(context: Context): Pair<Uri, File> {
    val dir = File(context.cacheDir, "face_photos").apply { mkdirs() }
    val file = File(dir, "face_${UUID.randomUUID()}.jpg")
    val authority = "${context.packageName}.fileprovider"
    val uri = FileProvider.getUriForFile(context, authority, file)
    return uri to file
}
