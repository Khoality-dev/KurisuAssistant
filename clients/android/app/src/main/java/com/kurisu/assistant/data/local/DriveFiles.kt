package com.kurisu.assistant.data.local

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.domain.drive.DownloadTarget
import com.kurisu.assistant.domain.drive.UploadSource
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The phone's side of a drive transfer (#175): a picked file to read, and the
 * places a download lands — the app's cache, for opening and sharing, or a
 * document the user chose with "Save to phone". URIs are strings so the view
 * model stays plain Kotlin.
 *
 * A cached copy lives at `cache/drive/<id>-<version>/<name>`, the version from
 * the server's checksum, so a file changed on the drive is fetched again and
 * an unchanged one opens straight away. `file_paths.xml` shares `drive/`.
 */
@Singleton
class DriveFiles @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val resolver get() = context.contentResolver

    fun source(uri: String): UploadSource {
        val parsed = Uri.parse(uri)
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    name = c.getString(0)
                    size = if (c.isNull(1)) null else c.getLong(1)
                }
            }
        }
        val shown = name?.takeIf { it.isNotBlank() } ?: parsed.lastPathSegment ?: "file"
        val length = size
        return object : UploadSource {
            override val name: String = shown
            override val size: Long? = length
            override fun open(): InputStream =
                resolver.openInputStream(parsed) ?: throw IOException("$shown can't be read.")
        }
    }

    /** A copy already on the phone and complete, as a URI to hand on; null when there is none. */
    fun cached(node: DriveNode): String? =
        cacheFile(node).takeIf { it.isFile && it.length() == node.size }?.let(::shareable)

    fun cacheTarget(node: DriveNode): DownloadTarget {
        val file = cacheFile(node)
        val part = File(file.parentFile, "${file.name}.part")
        return object : DownloadTarget {
            override fun open(): OutputStream {
                file.parentFile?.mkdirs()
                return part.outputStream()
            }

            override fun commit(): String {
                if (!part.renameTo(file)) throw IOException("${node.name} could not be saved on this phone.")
                // Older versions of the same file are not needed any more.
                File(context.cacheDir, CACHE_DIR).listFiles { f -> f.name.startsWith("${node.id}-") && f != file.parentFile }
                    ?.forEach { it.deleteRecursively() }
                return shareable(file)
            }

            override fun discard() {
                part.delete()
            }
        }
    }

    fun documentTarget(uri: String): DownloadTarget {
        val parsed = Uri.parse(uri)
        return object : DownloadTarget {
            override fun open(): OutputStream =
                resolver.openOutputStream(parsed, "wt") ?: throw IOException("That place on the phone can't be written to.")

            override fun commit(): String = uri

            // The picker made the document before a byte arrived; a failed save must not leave it half-written.
            override fun discard() {
                runCatching { DocumentsContract.deleteDocument(resolver, parsed) }
            }
        }
    }

    private fun cacheFile(node: DriveNode): File {
        val version = (node.checksum ?: node.updatedAt ?: "0").filter { it.isLetterOrDigit() }.take(16)
        return File(context.cacheDir, "$CACHE_DIR/${node.id}-$version/${node.name}")
    }

    private fun shareable(file: File): String =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file).toString()

    private companion object {
        const val CACHE_DIR = "drive"
    }
}
