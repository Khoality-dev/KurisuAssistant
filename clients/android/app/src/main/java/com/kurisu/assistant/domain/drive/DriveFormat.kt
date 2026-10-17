package com.kurisu.assistant.domain.drive

import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.model.PermissionMode
import com.kurisu.assistant.ui.assistant.apiErrorDetail
import com.kurisu.assistant.ui.assistant.apiErrorMessage
import retrofit2.HttpException
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What the Drive screen says about a size, a date, a name and a failure (#175). */
object DriveFormat {

    const val TOO_LARGE = "That file is larger than the server allows."
    const val DRIVE_FULL = "Your drive is full. Remove something, or ask for more space."

    private val time = DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)
    private val day = DateTimeFormatter.ofPattern("MMM d", Locale.ENGLISH)
    private val dayAndYear = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.ENGLISH)

    /** Binary units with one decimal, as the desktop's `formatBytes` writes them. */
    fun bytes(bytes: Long): String {
        val kib = 1024.0
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> String.format(Locale.ENGLISH, "%.1f KB", bytes / kib)
            bytes < 1024L * 1024 * 1024 -> String.format(Locale.ENGLISH, "%.1f MB", bytes / (kib * kib))
            else -> String.format(Locale.ENGLISH, "%.1f GB", bytes / (kib * kib * kib))
        }
    }

    /** A time today, a day this year, a day and year before that; in the phone's zone. */
    fun modified(iso: String?, now: ZonedDateTime): String {
        val at = iso?.let { runCatching { Instant.parse(it).atZone(now.zone) }.getOrNull() } ?: return ""
        return when {
            at.toLocalDate() == now.toLocalDate() -> time.format(at)
            at.year == now.year -> day.format(at)
            else -> dayAndYear.format(at)
        }
    }

    fun rowMeta(node: DriveNode, now: ZonedDateTime): String {
        val date = modified(node.updatedAt, now)
        if (node.isDir) return date
        return listOf(bytes(node.size), date).filter { it.isNotEmpty() }.joinToString(" · ")
    }

    fun usageLine(usage: DriveUsage): String = "${bytes(usage.usedBytes)} of ${bytes(usage.quotaBytes)}"

    fun usageDetail(usage: DriveUsage): String {
        val files = if (usage.fileCount == 1) "1 file" else "${usage.fileCount} files"
        return "$files · up to ${bytes(usage.maxFileBytes)} per file"
    }

    /**
     * The drive is reached by the assistant's tools, so what it may do there is
     * the account's permission mode (#360). Always ask means every call, reads
     * included.
     */
    fun assistantAccess(mode: PermissionMode): String = when (mode) {
        PermissionMode.ASK -> "Asks before it reads, writes or deletes anything"
        PermissionMode.READ_ONLY -> "Reads the whole drive · can't write or delete"
        PermissionMode.FULL -> "Reads, writes and deletes without asking"
    }

    /** "budget.xlsx" → "budget (1).xlsx", counting up past every name in [taken]. */
    fun keepBothName(name: String, taken: Set<String>): String {
        val dot = name.lastIndexOf('.')
        val (stem, ext) = if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
        var n = 1
        while ("$stem ($n)$ext" in taken) n++
        return "$stem ($n)$ext"
    }

    /**
     * The server's own sentence when it gave one. An oversized body is refused by
     * nginx with a page of its own, not JSON, so 413 and 507 still say why.
     */
    fun errorMessage(t: Throwable, fallback: String): String {
        val code = (t as? HttpException)?.code()
        if (code == 413 || code == 507) {
            return apiErrorDetail(t) ?: if (code == 413) TOO_LARGE else DRIVE_FULL
        }
        return apiErrorMessage(t, fallback)
    }
}
