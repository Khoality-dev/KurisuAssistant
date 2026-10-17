package com.kurisu.assistant.ui.drive

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.kurisu.assistant.data.local.DriveFiles
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.model.PermissionMode
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.DriveRepository
import com.kurisu.assistant.domain.drive.DownloadPurpose
import com.kurisu.assistant.domain.drive.DriveFormat
import com.kurisu.assistant.domain.drive.DriveTransfer
import com.kurisu.assistant.domain.drive.DriveTransfers
import com.kurisu.assistant.domain.drive.TransferDirection
import com.kurisu.assistant.domain.drive.TransferStatus
import com.kurisu.assistant.domain.drive.UploadSource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** One step of the path to the open folder; a null [id] is the drive's root. */
data class DriveCrumb(val id: Int?, val name: String)

val DRIVE_ROOT = DriveCrumb(null, "Drive")

sealed interface DriveDialog {
    data class NewFolder(val error: String? = null) : DriveDialog
    data class Rename(val node: DriveNode, val error: String? = null) : DriveDialog
    data class Delete(val node: DriveNode) : DriveDialog

    /** An upload whose name is taken here. [others] is how many more of this batch clash too. */
    data class Conflict(val name: String, val keepBothName: String, val place: String, val others: Int) : DriveDialog
    data object PermissionModePicker : DriveDialog
}

enum class ConflictChoice { REPLACE, KEEP_BOTH, SKIP }

/** The Move sheet: browsing for the folder to move [node] into. */
data class DriveMoveState(
    val node: DriveNode,
    val path: List<DriveCrumb>,
    val folders: List<DriveNode> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
) {
    /** Moving a node to where it already is does nothing; the button says so by being off. */
    val canMoveHere: Boolean get() = !isLoading && path.last().id != node.parentId
}

data class DriveUiState(
    val path: List<DriveCrumb> = listOf(DRIVE_ROOT),
    val nodes: List<DriveNode> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
    val usage: DriveUsage? = null,
    val permissionMode: PermissionMode? = null,
    val dialog: DriveDialog? = null,
    val move: DriveMoveState? = null,
    /** One sentence for a snackbar: a failure, or what just happened. */
    val message: String? = null,
) {
    val folderId: Int? get() = path.last().id
    val atRoot: Boolean get() = path.size == 1
    val title: String get() = path.last().name
}

/** Something to hand to another app. */
sealed interface DriveEvent {
    data class View(val uri: String, val mime: String) : DriveEvent
    data class Share(val uri: String, val mime: String) : DriveEvent
}

/** "Drive › Reports › 2026": where an upload goes, said in words. */
fun placeOf(path: List<DriveCrumb>): String = path.joinToString(" › ") { it.name }

/**
 * Kurisu Drive on the phone (#175): browse the account's files, put files on
 * it, take them off it, and rename, move and delete what is there.
 *
 * Transfers belong to [DriveTransfers], which outlives this screen; this only
 * starts them, and acts on the ones it started when they finish — a file
 * tapped opens once it has arrived, a shared one goes to the share sheet.
 */
@HiltViewModel
class DriveViewModel @Inject constructor(
    private val repo: DriveRepository,
    private val transfers: DriveTransfers,
    private val files: DriveFiles,
    private val assistantRepository: AssistantRepository,
) : ViewModel() {

    companion object {
        private const val TAG = "DriveViewModel"
        const val ON_THIS_PHONE = "this phone"
    }

    private val _state = MutableStateFlow(DriveUiState())
    val state: StateFlow<DriveUiState> = _state

    // A channel, not a shared flow: an event raised before the screen collects is
    // kept for it rather than dropped.
    private val _events = Channel<DriveEvent>(Channel.BUFFERED)
    val events: Flow<DriveEvent> = _events.receiveAsFlow()

    val transferList: StateFlow<List<DriveTransfer>> = transfers.transfers

    /** Downloads this screen started to open or share, by transfer id. */
    private val handOff = mutableMapOf<Long, DownloadPurpose>()

    /** Picked files still to go, and the answer given for the rest of a batch's clashes. */
    private val pending = ArrayDeque<UploadSource>()
    private var batchChoice: ConflictChoice? = null
    private var batchNames = mutableSetOf<String>()

    private var loading: Job? = null

    init {
        load()
        loadUsage()
        loadPermissionMode()
        viewModelScope.launch { transfers.finished.collect(::onFinished) }
    }

    // ---- Browsing ----

    fun refresh() {
        load()
        loadUsage()
    }

    fun open(node: DriveNode) {
        if (node.isDir) {
            _state.update { it.copy(path = it.path + DriveCrumb(node.id, node.name)) }
            load()
        } else {
            handOver(node, DownloadPurpose.OPEN)
        }
    }

    /** One folder up. False at the root, where Back leaves the screen. */
    fun up(): Boolean {
        if (_state.value.atRoot) return false
        _state.update { it.copy(path = it.path.dropLast(1)) }
        load()
        return true
    }

    fun goTo(index: Int) {
        val path = _state.value.path
        if (index !in path.indices || index == path.lastIndex) return
        _state.update { it.copy(path = path.take(index + 1)) }
        load()
    }

    private fun load() {
        val folderId = _state.value.folderId
        loading?.cancel()
        _state.update { it.copy(isLoading = true, error = null) }
        loading = viewModelScope.launch {
            try {
                val nodes = repo.list(folderId)
                _state.update { if (it.folderId == folderId) it.copy(nodes = nodes, isLoading = false) else it }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Log.e(TAG, "Failed to list folder $folderId", e)
                _state.update { it.copy(isLoading = false, error = DriveFormat.errorMessage(e, "Could not open this folder")) }
            }
        }
    }

    private fun loadUsage() {
        viewModelScope.launch {
            runCatching { repo.usage() }.onSuccess { usage -> _state.update { it.copy(usage = usage) } }
        }
    }

    private fun loadPermissionMode() {
        viewModelScope.launch {
            runCatching { assistantRepository.getAssistant() }
                .onSuccess { a -> _state.update { it.copy(permissionMode = a.permissionMode) } }
        }
    }

    // ---- Taking files off the drive ----

    fun share(node: DriveNode) = handOver(node, DownloadPurpose.SHARE)

    fun saveToPhone(node: DriveNode, uri: String) {
        transfers.download(node, files.documentTarget(uri), DownloadPurpose.SAVE, ON_THIS_PHONE)
    }

    /** Open or share [node]: straight away when a copy is on the phone, after downloading it when not. */
    private fun handOver(node: DriveNode, purpose: DownloadPurpose) {
        val mime = node.mime ?: "application/octet-stream"
        val cached = files.cached(node)
        if (cached != null) {
            _events.trySend(eventFor(purpose, cached, mime))
            return
        }
        val id = transfers.download(node, files.cacheTarget(node), purpose, ON_THIS_PHONE)
        handOff[id] = purpose
    }

    fun openTransfer(transfer: DriveTransfer) {
        val uri = transfer.resultUri ?: return
        _events.trySend(DriveEvent.View(uri, transfer.mime ?: "application/octet-stream"))
    }

    fun stopTransfer(id: Long) = transfers.stop(id)

    fun clearFinishedTransfers() = transfers.clearFinished()

    private fun eventFor(purpose: DownloadPurpose, uri: String, mime: String): DriveEvent =
        if (purpose == DownloadPurpose.SHARE) DriveEvent.Share(uri, mime) else DriveEvent.View(uri, mime)

    private fun onFinished(transfer: DriveTransfer) {
        val purpose = handOff.remove(transfer.id)
        if (purpose != null && transfer.status == TransferStatus.DONE && transfer.resultUri != null) {
            _events.trySend(eventFor(purpose, transfer.resultUri, transfer.mime ?: "application/octet-stream"))
        }
        if (transfer.direction == TransferDirection.UP && transfer.status == TransferStatus.DONE) {
            if (transfer.folderId == _state.value.folderId) load()
            loadUsage()
        }
    }

    // ---- Changing what is there ----

    fun showNewFolder() = _state.update { it.copy(dialog = DriveDialog.NewFolder()) }

    fun createFolder(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        val folderId = _state.value.folderId
        viewModelScope.launch {
            try {
                repo.createFolder(folderId, trimmed)
                _state.update { it.copy(dialog = null) }
                load()
            } catch (e: Exception) {
                _state.update { it.copy(dialog = DriveDialog.NewFolder(error = DriveFormat.errorMessage(e, "Could not make the folder"))) }
            }
        }
    }

    fun startRename(node: DriveNode) = _state.update { it.copy(dialog = DriveDialog.Rename(node)) }

    fun rename(name: String) {
        val dialog = _state.value.dialog as? DriveDialog.Rename ?: return
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        if (trimmed == dialog.node.name) {
            _state.update { it.copy(dialog = null) }
            return
        }
        viewModelScope.launch {
            try {
                repo.rename(dialog.node.id, trimmed)
                _state.update { it.copy(dialog = null) }
                load()
            } catch (e: Exception) {
                _state.update { it.copy(dialog = dialog.copy(error = DriveFormat.errorMessage(e, "Could not rename it"))) }
            }
        }
    }

    fun startDelete(node: DriveNode) = _state.update { it.copy(dialog = DriveDialog.Delete(node)) }

    fun confirmDelete() {
        val dialog = _state.value.dialog as? DriveDialog.Delete ?: return
        _state.update { it.copy(dialog = null) }
        viewModelScope.launch {
            try {
                repo.delete(dialog.node.id)
                load()
                loadUsage()
            } catch (e: Exception) {
                _state.update { it.copy(message = DriveFormat.errorMessage(e, "Could not delete ${dialog.node.name}")) }
            }
        }
    }

    fun dismissDialog() {
        if (_state.value.dialog is DriveDialog.Conflict) {
            // Closing the question skips the rest of the batch's clashes too.
            pending.clear()
            batchChoice = null
        }
        _state.update { it.copy(dialog = null) }
    }

    // ---- Move ----

    /** Opens on the folder the node is in: the likeliest place to start looking from. */
    fun startMove(node: DriveNode) {
        _state.update { it.copy(move = DriveMoveState(node = node, path = it.path)) }
        loadMoveFolders()
    }

    fun moveInto(folder: DriveNode) {
        val move = _state.value.move ?: return
        _state.update { it.copy(move = move.copy(path = move.path + DriveCrumb(folder.id, folder.name))) }
        loadMoveFolders()
    }

    fun moveGoTo(index: Int) {
        val move = _state.value.move ?: return
        if (index !in move.path.indices || index == move.path.lastIndex) return
        _state.update { it.copy(move = move.copy(path = move.path.take(index + 1))) }
        loadMoveFolders()
    }

    fun moveHere() {
        val move = _state.value.move ?: return
        if (!move.canMoveHere) return
        val to = move.path.last().id
        viewModelScope.launch {
            try {
                repo.move(move.node.id, to)
                _state.update { it.copy(move = null) }
                load()
            } catch (e: Exception) {
                _state.update { s -> s.copy(move = s.move?.copy(error = DriveFormat.errorMessage(e, "Could not move it"))) }
            }
        }
    }

    fun cancelMove() = _state.update { it.copy(move = null) }

    private fun loadMoveFolders() {
        val move = _state.value.move ?: return
        val folderId = move.path.last().id
        _state.update { it.copy(move = move.copy(isLoading = true, error = null)) }
        viewModelScope.launch {
            try {
                // A folder cannot go inside itself, so it is not offered as a way in.
                val folders = repo.list(folderId).filter { it.isDir && it.id != move.node.id }
                _state.update { s ->
                    val m = s.move ?: return@update s
                    if (m.path.last().id != folderId) s else s.copy(move = m.copy(folders = folders, isLoading = false))
                }
            } catch (e: Exception) {
                _state.update { s -> s.copy(move = s.move?.copy(isLoading = false, error = DriveFormat.errorMessage(e, "Could not open this folder"))) }
            }
        }
    }

    // ---- Putting files on the drive ----

    fun upload(uris: List<String>) {
        if (uris.isEmpty()) return
        pending.addAll(uris.map(files::source))
        batchChoice = null
        batchNames = _state.value.nodes.map { it.name }.toMutableSet()
        nextUpload()
    }

    fun resolveConflict(choice: ConflictChoice, forTheOthers: Boolean) {
        if (_state.value.dialog !is DriveDialog.Conflict) return
        val source = pending.removeFirstOrNull() ?: return
        _state.update { it.copy(dialog = null) }
        if (forTheOthers) batchChoice = choice
        answer(source, choice)
        nextUpload()
    }

    /**
     * Sends every picked file whose name is free straight away, then asks about
     * the clashes one at a time — or answers them all, once told to.
     */
    private fun nextUpload() {
        val clashing = ArrayDeque<UploadSource>()
        for (source in pending) {
            if (source.name in batchNames) clashing += source else start(source, source.name, overwrite = false)
        }
        pending.clear()
        pending.addAll(clashing)
        while (pending.isNotEmpty()) {
            val source = pending.first()
            val remembered = batchChoice
            if (remembered != null) {
                pending.removeFirst()
                answer(source, remembered)
                continue
            }
            val others = pending.size - 1
            _state.update {
                it.copy(dialog = DriveDialog.Conflict(
                    name = source.name,
                    keepBothName = DriveFormat.keepBothName(source.name, batchNames),
                    place = placeOf(it.path),
                    others = others,
                ))
            }
            return
        }
    }

    private fun answer(source: UploadSource, choice: ConflictChoice) {
        when (choice) {
            ConflictChoice.REPLACE -> start(source, source.name, overwrite = true)
            ConflictChoice.KEEP_BOTH -> start(source, DriveFormat.keepBothName(source.name, batchNames), overwrite = false)
            ConflictChoice.SKIP -> {}
        }
    }

    private fun start(source: UploadSource, name: String, overwrite: Boolean) {
        batchNames += name
        val s = _state.value
        transfers.upload(source, s.folderId, placeOf(s.path), overwrite, name)
    }

    // ---- What the assistant may do ----

    fun showPermissionMode() = _state.update { it.copy(dialog = DriveDialog.PermissionModePicker) }

    /** The account's permission mode (#360), as the chat's chip changes it: optimistic, rolled back on a refusal. */
    fun setPermissionMode(mode: PermissionMode) {
        val previous = _state.value.permissionMode
        _state.update { it.copy(dialog = null, permissionMode = mode) }
        if (previous == mode) return
        viewModelScope.launch {
            try {
                val updated = assistantRepository.updateAssistant(AssistantUpdate(permissionMode = mode))
                _state.update { it.copy(permissionMode = updated.permissionMode) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to change the permission mode", e)
                _state.update { it.copy(permissionMode = previous, message = "Could not change the permission mode") }
            }
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }
}
