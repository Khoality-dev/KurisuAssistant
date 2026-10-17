package com.kurisu.assistant.domain.drive

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.model.PermissionMode
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.time.ZoneId
import java.time.ZonedDateTime

/** What the Drive screen says about a size, a date, a name and a failure (#175). */
class DriveFormatTest {

    private val zone = ZoneId.of("America/Los_Angeles")
    private val now = ZonedDateTime.of(2026, 10, 16, 21, 30, 0, 0, zone)

    private fun http(code: Int, body: String, type: String = "application/json") =
        HttpException(Response.error<Any>(code, body.toResponseBody(type.toMediaType())))

    @Test
    fun `sizes read as the desktop writes them`() {
        assertThat(DriveFormat.bytes(0)).isEqualTo("0 B")
        assertThat(DriveFormat.bytes(1023)).isEqualTo("1023 B")
        assertThat(DriveFormat.bytes(1536)).isEqualTo("1.5 KB")
        assertThat(DriveFormat.bytes(2_516_582)).isEqualTo("2.4 MB")
        assertThat(DriveFormat.bytes(15L * 1024 * 1024 * 1024)).isEqualTo("15.0 GB")
    }

    @Test
    fun `a date is a time today, a day this year, and a day and year before that`() {
        // 2026-10-17T03:05Z is 20:05 on the 16th in Los Angeles: the phone's day, not UTC's.
        assertThat(DriveFormat.modified("2026-10-17T03:05:00Z", now)).isEqualTo("20:05")
        assertThat(DriveFormat.modified("2026-10-12T18:00:00Z", now)).isEqualTo("Oct 12")
        assertThat(DriveFormat.modified("2025-03-02T18:00:00Z", now)).isEqualTo("Mar 2, 2025")
        assertThat(DriveFormat.modified(null, now)).isEqualTo("")
        assertThat(DriveFormat.modified("not a date", now)).isEqualTo("")
    }

    @Test
    fun `a folder's row says when it changed and a file's its size too`() {
        val folder = DriveNode(id = 1, name = "Reports", isDir = true, updatedAt = "2026-10-14T18:00:00Z")
        val file = DriveNode(id = 2, name = "Q3 report.pdf", size = 2_516_582, updatedAt = "2026-10-14T18:00:00Z")
        assertThat(DriveFormat.rowMeta(folder, now)).isEqualTo("Oct 14")
        assertThat(DriveFormat.rowMeta(file, now)).isEqualTo("2.4 MB · Oct 14")
        assertThat(DriveFormat.rowMeta(file.copy(updatedAt = null), now)).isEqualTo("2.4 MB")
    }

    @Test
    fun `the storage card says how full the drive is and what one file may be`() {
        val usage = DriveUsage(usedBytes = 3_435_973_837, quotaBytes = 15L * 1024 * 1024 * 1024, fileCount = 214, maxFileBytes = 2L * 1024 * 1024 * 1024)
        assertThat(DriveFormat.usageLine(usage)).isEqualTo("3.2 GB of 15.0 GB")
        assertThat(DriveFormat.usageDetail(usage)).isEqualTo("214 files · up to 2.0 GB per file")
        assertThat(DriveFormat.usageDetail(usage.copy(fileCount = 1))).isEqualTo("1 file · up to 2.0 GB per file")
    }

    @Test
    fun `what the assistant may do with the drive follows the account's permission mode`() {
        // Always ask means every call, reads included (#360).
        assertThat(DriveFormat.assistantAccess(PermissionMode.ASK)).isEqualTo("Asks before it reads, writes or deletes anything")
        assertThat(DriveFormat.assistantAccess(PermissionMode.READ_ONLY)).isEqualTo("Reads the whole drive · can't write or delete")
        assertThat(DriveFormat.assistantAccess(PermissionMode.FULL)).isEqualTo("Reads, writes and deletes without asking")
    }

    @Test
    fun `keep both numbers the new copy before its extension`() {
        assertThat(DriveFormat.keepBothName("budget.xlsx", setOf("budget.xlsx"))).isEqualTo("budget (1).xlsx")
        assertThat(DriveFormat.keepBothName("budget.xlsx", setOf("budget.xlsx", "budget (1).xlsx"))).isEqualTo("budget (2).xlsx")
        assertThat(DriveFormat.keepBothName("notes", setOf("notes"))).isEqualTo("notes (1)")
        assertThat(DriveFormat.keepBothName(".profile", setOf(".profile"))).isEqualTo(".profile (1)")
    }

    @Test
    fun `a refusal is the server's own sentence, and a size or quota refusal without one still says why`() {
        assertThat(DriveFormat.errorMessage(http(409, """{"detail":"'a.txt' already exists here"}"""), "x"))
            .isEqualTo("'a.txt' already exists here")
        assertThat(DriveFormat.errorMessage(http(507, """{"detail":"Your drive is full. Remove something, or ask for more space."}"""), "x"))
            .isEqualTo("Your drive is full. Remove something, or ask for more space.")
        // nginx answers an oversized body itself, with a page, not JSON.
        assertThat(DriveFormat.errorMessage(http(413, "<html>413 Request Entity Too Large</html>", "text/html"), "x"))
            .isEqualTo("That file is larger than the server allows.")
        assertThat(DriveFormat.errorMessage(http(507, ""), "x"))
            .isEqualTo("Your drive is full. Remove something, or ask for more space.")
    }
}
