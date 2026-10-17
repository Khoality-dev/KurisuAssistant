package com.kurisu.assistant.domain.drive

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.repository.DriveRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.buffer
import okio.source
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Uploads to and downloads from the drive (#175): one at a time, in the app's
 * scope, with how far each has got, a reason when one fails, and a stop that
 * leaves nothing half-written behind.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DriveTransfersTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: DriveRepository
    private lateinit var transfers: DriveTransfers

    private val gib = 1024L * 1024 * 1024
    private val roomy = DriveUsage(usedBytes = 0, quotaBytes = 15 * gib, fileCount = 0, maxFileBytes = 2 * gib)

    private class Source(override val name: String, val bytes: ByteArray) : UploadSource {
        var opens = 0
        override val size: Long = bytes.size.toLong()
        override fun open(): InputStream {
            opens++
            return ByteArrayInputStream(bytes)
        }
    }

    private class Target : DownloadTarget {
        val written = ByteArrayOutputStream()
        var committed = false
        var discarded = false
        override fun open(): OutputStream = written
        override fun commit(): String {
            committed = true
            return "content://cache/report.pdf"
        }
        override fun discard() {
            discarded = true
        }
    }

    private fun http(code: Int, detail: String) =
        HttpException(Response.error<Any>(code, """{"detail":"$detail"}""".toResponseBody("application/json".toMediaType())))

    private fun sent(body: RequestBody): ByteArray = Buffer().also { body.writeTo(it) }.readByteArray()

    private fun only() = transfers.transfers.value.single()

    @Before
    fun setUp() {
        repo = mockk(relaxed = true)
        coEvery { repo.usage() } returns roomy
    }

    /**
     * The transfers run in a scope of their own on the test's clock, as they do in
     * the app's — not `backgroundScope`, whose work `advanceUntilIdle` never runs.
     */
    private fun drive(block: suspend TestScope.() -> Unit) = runTest(dispatcher) {
        val own = CoroutineScope(dispatcher + Job())
        transfers = DriveTransfers(repo, own)
        try {
            block()
        } finally {
            own.cancel()
        }
    }

    @Test
    fun `an upload sends the file's bytes and ends done, with the node the server made`() = drive {
        val source = Source("notes.md", "hello drive".toByteArray())
        var body: ByteArray? = null
        coEvery { repo.upload("notes.md", 5, false, any()) } coAnswers {
            body = sent(arg(3))
            DriveNode(id = 40, parentId = 5, name = "notes.md", size = 11)
        }
        val finished = mutableListOf<DriveTransfer>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { transfers.finished.collect { finished += it } }

        val id = transfers.upload(source, folderId = 5, place = "Drive › Notes", overwrite = false)
        advanceUntilIdle()

        assertThat(body).isEqualTo("hello drive".toByteArray())
        with(only()) {
            assertThat(this.id).isEqualTo(id)
            assertThat(direction).isEqualTo(TransferDirection.UP)
            assertThat(status).isEqualTo(TransferStatus.DONE)
            assertThat(transferredBytes).isEqualTo(11)
            assertThat(totalBytes).isEqualTo(11)
            assertThat(nodeId).isEqualTo(40)
            assertThat(folderId).isEqualTo(5)
            assertThat(place).isEqualTo("Drive › Notes")
        }
        assertThat(finished.map { it.id }).containsExactly(id)
    }

    @Test
    fun `a file over the server's limit is refused before a byte is sent`() = drive {
        coEvery { repo.usage() } returns roomy.copy(maxFileBytes = 4)
        transfers.upload(Source("big.bin", ByteArray(5)), folderId = null, place = "Drive", overwrite = false)
        advanceUntilIdle()

        assertThat(only().status).isEqualTo(TransferStatus.FAILED)
        assertThat(only().error).isEqualTo("That file is larger than the server allows (up to 4 B).")
        coVerify(exactly = 0) { repo.upload(any(), any(), any(), any()) }
    }

    @Test
    fun `a drive with no room left refuses a new file before it is sent`() = drive {
        coEvery { repo.usage() } returns roomy.copy(usedBytes = 10, quotaBytes = 12)
        transfers.upload(Source("a.txt", ByteArray(3)), folderId = null, place = "Drive", overwrite = false)
        advanceUntilIdle()

        assertThat(only().error).isEqualTo("Your drive is full. Remove something, or ask for more space.")
        coVerify(exactly = 0) { repo.upload(any(), any(), any(), any()) }
    }

    @Test
    fun `a refused upload says the server's reason`() = drive {
        coEvery { repo.upload(any(), any(), any(), any()) } throws http(409, "'a.txt' already exists here")
        transfers.upload(Source("a.txt", ByteArray(3)), folderId = null, place = "Drive", overwrite = false)
        advanceUntilIdle()

        assertThat(only().status).isEqualTo(TransferStatus.FAILED)
        assertThat(only().error).isEqualTo("'a.txt' already exists here")
    }

    @Test
    fun `an upload refused for an expired login is sent again, from the start`() = drive {
        val source = Source("a.txt", "abc".toByteArray())
        var attempts = 0
        coEvery { repo.upload(any(), any(), any(), any()) } coAnswers {
            attempts++
            sent(arg(3))
            if (attempts == 1) throw http(401, "Not authenticated")
            DriveNode(id = 1, name = "a.txt", size = 3)
        }
        transfers.upload(source, folderId = null, place = "Drive", overwrite = false)
        advanceUntilIdle()

        assertThat(attempts).isEqualTo(2)
        assertThat(source.opens).isEqualTo(2)
        assertThat(only().status).isEqualTo(TransferStatus.DONE)
    }

    @Test
    fun `a download is written to its target and committed, then reported`() = drive {
        val node = DriveNode(id = 9, name = "report.pdf", size = 7, mime = "application/pdf")
        coEvery { repo.download(9) } returns "%PDF-1x".toResponseBody("application/octet-stream".toMediaType())
        val target = Target()
        val finished = mutableListOf<DriveTransfer>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { transfers.finished.collect { finished += it } }

        transfers.download(node, target, DownloadPurpose.OPEN, place = "this phone")
        advanceUntilIdle()

        assertThat(target.written.toString()).isEqualTo("%PDF-1x")
        assertThat(target.committed).isTrue()
        with(only()) {
            assertThat(direction).isEqualTo(TransferDirection.DOWN)
            assertThat(status).isEqualTo(TransferStatus.DONE)
            assertThat(transferredBytes).isEqualTo(7)
            assertThat(resultUri).isEqualTo("content://cache/report.pdf")
            assertThat(mime).isEqualTo("application/pdf")
            assertThat(purpose).isEqualTo(DownloadPurpose.OPEN)
        }
        assertThat(finished.single().resultUri).isEqualTo("content://cache/report.pdf")
    }

    @Test
    fun `a download that breaks off leaves nothing behind`() = drive {
        val node = DriveNode(id = 9, name = "report.pdf", size = 100)
        val broken = object : ResponseBody() {
            override fun contentLength() = 100L
            override fun contentType() = null
            override fun source(): BufferedSource = object : InputStream() {
                var n = 0
                override fun read(): Int = if (n++ < 10) 'x'.code else throw IOException("connection reset")
            }.source().buffer()
        }
        coEvery { repo.download(9) } returns broken
        val target = Target()

        transfers.download(node, target, DownloadPurpose.SAVE, place = "this phone")
        advanceUntilIdle()

        assertThat(only().status).isEqualTo(TransferStatus.FAILED)
        assertThat(target.discarded).isTrue()
        assertThat(target.committed).isFalse()
    }

    @Test
    fun `transfers go one at a time, and one still waiting can be stopped`() = drive {
        val gate = CompletableDeferred<Unit>()
        coEvery { repo.upload("first.txt", any(), any(), any()) } coAnswers {
            gate.await()
            DriveNode(id = 1, name = "first.txt")
        }
        val first = transfers.upload(Source("first.txt", ByteArray(1)), null, "Drive", false)
        val second = transfers.upload(Source("second.txt", ByteArray(1)), null, "Drive", false)
        advanceUntilIdle()

        val byId = transfers.transfers.value.associateBy { it.id }
        assertThat(byId.getValue(first).status).isEqualTo(TransferStatus.ACTIVE)
        assertThat(byId.getValue(second).status).isEqualTo(TransferStatus.WAITING)

        transfers.stop(second)
        gate.complete(Unit)
        advanceUntilIdle()

        val after = transfers.transfers.value.associateBy { it.id }
        assertThat(after.getValue(first).status).isEqualTo(TransferStatus.DONE)
        assertThat(after.getValue(second).status).isEqualTo(TransferStatus.STOPPED)
        coVerify(exactly = 0) { repo.upload("second.txt", any(), any(), any()) }
    }

    @Test
    fun `stopping the one in progress cancels it and removes the partial file`() = drive {
        coEvery { repo.download(9) } coAnswers { awaitCancellation() }
        val target = Target()
        val id = transfers.download(DriveNode(id = 9, name = "big.iso", size = 10), target, DownloadPurpose.SAVE, "this phone")
        advanceUntilIdle()
        assertThat(only().status).isEqualTo(TransferStatus.ACTIVE)

        transfers.stop(id)
        advanceUntilIdle()

        assertThat(only().status).isEqualTo(TransferStatus.STOPPED)
        assertThat(target.discarded).isTrue()
    }

    @Test
    fun `clearing finished ones keeps what is still going`() = drive {
        val gate = CompletableDeferred<Unit>()
        coEvery { repo.upload("slow.txt", any(), any(), any()) } coAnswers {
            gate.await()
            DriveNode(id = 2, name = "slow.txt")
        }
        coEvery { repo.upload("quick.txt", any(), any(), any()) } returns DriveNode(id = 1, name = "quick.txt")
        transfers.upload(Source("quick.txt", ByteArray(1)), null, "Drive", false)
        advanceUntilIdle()
        val slow = transfers.upload(Source("slow.txt", ByteArray(1)), null, "Drive", false)
        advanceUntilIdle()

        transfers.clearFinished()

        assertThat(transfers.transfers.value.map { it.id }).containsExactly(slow)
        gate.complete(Unit)
    }
}
