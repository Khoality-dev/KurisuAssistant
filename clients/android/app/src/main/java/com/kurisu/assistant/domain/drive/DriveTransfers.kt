package com.kurisu.assistant.domain.drive

import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.repository.DriveRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import retrofit2.HttpException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton

enum class TransferDirection { UP, DOWN }

enum class TransferStatus { WAITING, ACTIVE, DONE, FAILED, STOPPED }

/** What a download is for: opened in another app, shared, or saved where the user picked. */
enum class DownloadPurpose { OPEN, SHARE, SAVE }

/** A file on the phone to put on the drive. [open] is called for every attempt. */
interface UploadSource {
    val name: String
    val size: Long?
    fun open(): InputStream
}

/** Where a download lands. Nothing is there until [commit]; [discard] removes a partial one. */
interface DownloadTarget {
    fun open(): OutputStream

    /** The finished file as a URI another app can be handed. */
    fun commit(): String

    fun discard()
}

data class DriveTransfer(
    val id: Long,
    val direction: TransferDirection,
    val name: String,
    val totalBytes: Long?,
    val transferredBytes: Long = 0,
    val status: TransferStatus = TransferStatus.WAITING,
    val error: String? = null,
    /** Where it goes, in words: "Drive › Notes" for an upload, "this phone" for a download. */
    val place: String,
    /** An upload's folder. */
    val folderId: Int? = null,
    /** A download's file; an upload's, once the server has it. */
    val nodeId: Int? = null,
    val purpose: DownloadPurpose? = null,
    val mime: String? = null,
    /** A finished download, as a URI to open. */
    val resultUri: String? = null,
) {
    val progress: Float?
        get() = totalBytes?.takeIf { it > 0 }?.let { (transferredBytes.toFloat() / it).coerceIn(0f, 1f) }

    val isFinished: Boolean
        get() = status == TransferStatus.DONE || status == TransferStatus.FAILED || status == TransferStatus.STOPPED
}

/**
 * Every upload to and download from the drive (#175), one at a time, in the
 * app's own scope: leaving the Drive screen does not stop one. Bytes stream
 * from and to the phone's storage, so a large file is never held in memory.
 *
 * An upload asks the server how full the drive is first. That refuses a file
 * the server would refuse anyway before a byte of it is sent, and it is an
 * authenticated call, so an expired login is refreshed by `AuthInterceptor`
 * before the long request rather than in the middle of it. An upload still
 * refused with a 401 is sent once more, from the start: its body reopens the
 * file on every attempt.
 */
@Singleton
class DriveTransfers(
    private val repo: DriveRepository,
    private val scope: CoroutineScope,
) {
    @Inject
    constructor(repo: DriveRepository) : this(repo, CoroutineScope(SupervisorJob() + Dispatchers.IO))

    private val _transfers = MutableStateFlow<List<DriveTransfer>>(emptyList())
    val transfers: StateFlow<List<DriveTransfer>> = _transfers

    private val _finished = MutableSharedFlow<DriveTransfer>(extraBufferCapacity = 16)

    /** A transfer that has just finished, whichever way. */
    val finished: SharedFlow<DriveTransfer> = _finished

    private val ids = AtomicLong(1)
    private val queue = Channel<Long>(Channel.UNLIMITED)
    private val work = ConcurrentHashMap<Long, suspend () -> Unit>()
    private val running = ConcurrentHashMap<Long, Job>()

    init {
        scope.launch {
            for (id in queue) {
                val job = work.remove(id) ?: continue
                if (find(id)?.status != TransferStatus.WAITING) continue
                change(id) { it.copy(status = TransferStatus.ACTIVE) }
                val run = scope.launch { job() }
                running[id] = run
                run.join()
                running.remove(id)
            }
        }
    }

    fun upload(source: UploadSource, folderId: Int?, place: String, overwrite: Boolean, name: String = source.name): Long =
        enqueue(
            DriveTransfer(id = ids.getAndIncrement(), direction = TransferDirection.UP, name = name,
                totalBytes = source.size, place = place, folderId = folderId),
        ) { id -> runUpload(id, source, folderId, overwrite, name) }

    fun download(node: DriveNode, target: DownloadTarget, purpose: DownloadPurpose, place: String): Long =
        enqueue(
            DriveTransfer(id = ids.getAndIncrement(), direction = TransferDirection.DOWN, name = node.name,
                totalBytes = node.size.takeIf { it > 0 }, place = place, nodeId = node.id, purpose = purpose,
                mime = node.mime ?: "application/octet-stream"),
        ) { id -> runDownload(id, node, target) }

    /** A waiting transfer never starts; a running one is cancelled and leaves nothing behind. */
    fun stop(id: Long) {
        when (find(id)?.status) {
            TransferStatus.WAITING -> {
                work.remove(id)
                end(id) { it.copy(status = TransferStatus.STOPPED) }
            }
            TransferStatus.ACTIVE -> running[id]?.cancel()
            else -> {}
        }
    }

    fun clearFinished() {
        _transfers.update { list -> list.filterNot { it.isFinished } }
    }

    private fun enqueue(transfer: DriveTransfer, job: suspend (Long) -> Unit): Long {
        _transfers.update { it + transfer }
        work[transfer.id] = { job(transfer.id) }
        queue.trySend(transfer.id)
        return transfer.id
    }

    private suspend fun runUpload(id: Long, source: UploadSource, folderId: Int?, overwrite: Boolean, name: String) {
        try {
            val usage = repo.usage()
            val size = source.size
            if (size != null && usage.maxFileBytes > 0 && size > usage.maxFileBytes) {
                return fail(id, "That file is larger than the server allows (up to ${DriveFormat.bytes(usage.maxFileBytes)}).")
            }
            // A replaced file gives its own bytes back, which only the server knows.
            if (!overwrite && size != null && usage.quotaBytes > 0 && usage.usedBytes + size > usage.quotaBytes) {
                return fail(id, DriveFormat.DRIVE_FULL)
            }
            val node = try {
                repo.upload(name, folderId, overwrite, UploadBody(id, source))
            } catch (e: HttpException) {
                if (e.code() != 401) throw e
                repo.upload(name, folderId, overwrite, UploadBody(id, source))
            }
            end(id) { it.copy(status = TransferStatus.DONE, nodeId = node.id, transferredBytes = it.totalBytes ?: it.transferredBytes) }
        } catch (e: Exception) {
            if (e is CancellationException || !currentCoroutineContext().isActive) {
                end(id) { it.copy(status = TransferStatus.STOPPED) }
                if (e is CancellationException) throw e
            } else {
                fail(id, DriveFormat.errorMessage(e, "The upload failed."))
            }
        }
    }

    private suspend fun runDownload(id: Long, node: DriveNode, target: DownloadTarget) {
        try {
            var sent = 0L
            repo.download(node.id).use { body ->
                val total = body.contentLength().takeIf { it >= 0 } ?: node.size
                change(id) { it.copy(totalBytes = total) }
                // A read stalled on the network does not see the cancellation; closing the body ends it.
                val stop = currentCoroutineContext().job.invokeOnCompletion { body.close() }
                try {
                    target.open().use { out ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(CHUNK)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val n = input.read(buffer)
                                if (n < 0) break
                                out.write(buffer, 0, n)
                                sent += n
                                progress(id, sent)
                            }
                        }
                    }
                } finally {
                    stop.dispose()
                }
            }
            val uri = target.commit()
            end(id) { it.copy(status = TransferStatus.DONE, transferredBytes = sent, resultUri = uri) }
        } catch (e: Exception) {
            target.discard()
            if (e is CancellationException || !currentCoroutineContext().isActive) {
                end(id) { it.copy(status = TransferStatus.STOPPED) }
                if (e is CancellationException) throw e
            } else {
                fail(id, DriveFormat.errorMessage(e, "The download failed."))
            }
        }
    }

    /** The file, read afresh each time OkHttp writes the request. */
    private inner class UploadBody(private val id: Long, private val source: UploadSource) : RequestBody() {
        override fun contentType() = OCTET_STREAM
        override fun contentLength(): Long = source.size ?: -1

        override fun writeTo(sink: BufferedSink) {
            var sent = 0L
            change(id) { it.copy(transferredBytes = 0) }
            source.open().use { input ->
                val buffer = ByteArray(CHUNK)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    sink.write(buffer, 0, n)
                    sent += n
                    progress(id, sent)
                }
            }
        }
    }

    /** At most one update per percent, so a 2 GB file is not 30 000 list copies. */
    private fun progress(id: Long, bytes: Long) {
        val current = find(id) ?: return
        val total = current.totalBytes
        val step = if (total != null && total > 0) maxOf(total / 100, 1) else PROGRESS_STEP
        if (bytes - current.transferredBytes >= step || (total != null && bytes >= total)) {
            change(id) { it.copy(transferredBytes = bytes) }
        }
    }

    private fun fail(id: Long, message: String) = end(id) { it.copy(status = TransferStatus.FAILED, error = message) }

    private fun end(id: Long, f: (DriveTransfer) -> DriveTransfer) {
        change(id, f)
        find(id)?.let { _finished.tryEmit(it) }
    }

    private fun change(id: Long, f: (DriveTransfer) -> DriveTransfer) {
        _transfers.update { list -> list.map { if (it.id == id) f(it) else it } }
    }

    private fun find(id: Long): DriveTransfer? = _transfers.value.firstOrNull { it.id == id }

    private companion object {
        const val CHUNK = 64 * 1024
        const val PROGRESS_STEP = 256 * 1024L
        val OCTET_STREAM = "application/octet-stream".toMediaType()
    }
}
