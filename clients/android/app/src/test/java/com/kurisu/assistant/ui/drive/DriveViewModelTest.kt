package com.kurisu.assistant.ui.drive

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.DriveFiles
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.DriveNode
import com.kurisu.assistant.data.model.DriveUsage
import com.kurisu.assistant.data.model.PermissionMode
import com.kurisu.assistant.data.repository.AssistantRepository
import com.kurisu.assistant.data.repository.DriveRepository
import com.kurisu.assistant.domain.drive.DownloadPurpose
import com.kurisu.assistant.domain.drive.DownloadTarget
import com.kurisu.assistant.domain.drive.DriveTransfer
import com.kurisu.assistant.domain.drive.DriveTransfers
import com.kurisu.assistant.domain.drive.TransferDirection
import com.kurisu.assistant.domain.drive.TransferStatus
import com.kurisu.assistant.domain.drive.UploadSource
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.InputStream

/**
 * The Drive screen (#175): browsing folders, a file opened or shared or saved
 * to the phone, rename, move and delete, uploads whose name is already taken,
 * and what the assistant may do with the drive.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DriveViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: DriveRepository
    private lateinit var transfers: DriveTransfers
    private lateinit var files: DriveFiles
    private lateinit var assistants: AssistantRepository
    private val finished = MutableSharedFlow<DriveTransfer>(extraBufferCapacity = 8)

    private val reports = DriveNode(id = 5, parentId = null, name = "Reports", isDir = true)
    private val photos = DriveNode(id = 6, parentId = null, name = "Photos", isDir = true)
    private val shopping = DriveNode(id = 7, parentId = null, name = "shopping.txt", size = 10, mime = "text/plain")
    private val archive = DriveNode(id = 20, parentId = 5, name = "Archive", isDir = true)
    private val q3 = DriveNode(id = 21, parentId = 5, name = "Q3 report.pdf", size = 2_516_582, mime = "application/pdf")
    private val budget = DriveNode(id = 22, parentId = 5, name = "budget.xlsx", size = 88_000)
    private val tree = mapOf<Int?, List<DriveNode>>(
        null to listOf(photos, reports, shopping),
        5 to listOf(archive, budget, q3),
        20 to emptyList(),
        6 to emptyList(),
    )
    private val usage = DriveUsage(usedBytes = 100, quotaBytes = 1000, fileCount = 3, maxFileBytes = 500)

    private fun http(code: Int, detail: String) =
        HttpException(Response.error<Any>(code, """{"detail":"$detail"}""".toResponseBody("application/json".toMediaType())))

    private fun source(name: String) = object : UploadSource {
        override val name = name
        override val size: Long = 3
        override fun open(): InputStream = "abc".byteInputStream()
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        transfers = mockk(relaxed = true)
        files = mockk(relaxed = true)
        assistants = mockk(relaxed = true)
        coEvery { repo.list(any()) } answers { tree.getValue(firstArg()) }
        coEvery { repo.usage() } returns usage
        coEvery { assistants.getAssistant() } returns Assistant(id = 1, permissionMode = PermissionMode.READ_ONLY)
        every { transfers.transfers } returns MutableStateFlow(emptyList())
        every { transfers.finished } returns finished
        every { files.cached(any()) } returns null
        every { files.source(any()) } answers { source(firstArg<String>().substringAfterLast('/')) }
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun TestScope.viewModel(): DriveViewModel = DriveViewModel(repo, transfers, files, assistants).also { advanceUntilIdle() }

    private fun TestScope.events(vm: DriveViewModel): List<DriveEvent> {
        val seen = mutableListOf<DriveEvent>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.events.collect { seen += it } }
        return seen
    }

    @Test
    fun `opens on the root, with how full the drive is and what the assistant may do`() = runTest(dispatcher) {
        val vm = viewModel()
        with(vm.state.value) {
            assertThat(atRoot).isTrue()
            assertThat(title).isEqualTo("Drive")
            assertThat(nodes.map { it.name }).containsExactly("Photos", "Reports", "shopping.txt").inOrder()
            assertThat(isLoading).isFalse()
            assertThat(this.usage).isEqualTo(usage)
            assertThat(permissionMode).isEqualTo(PermissionMode.READ_ONLY)
        }
    }

    @Test
    fun `a folder opens in place, and up and the path go back`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        assertThat(vm.state.value.path).containsExactly(DRIVE_ROOT, DriveCrumb(5, "Reports")).inOrder()
        assertThat(vm.state.value.nodes.map { it.name }).containsExactly("Archive", "budget.xlsx", "Q3 report.pdf").inOrder()

        vm.open(archive); advanceUntilIdle()
        assertThat(vm.state.value.title).isEqualTo("Archive")
        assertThat(vm.up()).isTrue(); advanceUntilIdle()
        assertThat(vm.state.value.title).isEqualTo("Reports")

        vm.open(archive); advanceUntilIdle()
        vm.goTo(0); advanceUntilIdle()
        assertThat(vm.state.value.atRoot).isTrue()
        assertThat(vm.state.value.nodes.map { it.name }).contains("Reports")
        assertThat(vm.up()).isFalse()
    }

    @Test
    fun `a file already on the phone opens without downloading it again`() = runTest(dispatcher) {
        every { files.cached(shopping) } returns "content://cache/shopping.txt"
        val vm = viewModel()
        val seen = events(vm)
        vm.open(shopping); advanceUntilIdle()

        assertThat(seen).containsExactly(DriveEvent.View("content://cache/shopping.txt", "text/plain"))
        verify(exactly = 0) { transfers.download(any(), any(), any(), any()) }
    }

    @Test
    fun `a file not on the phone yet is downloaded, then opened`() = runTest(dispatcher) {
        val target = mockk<DownloadTarget>()
        every { files.cacheTarget(shopping) } returns target
        every { transfers.download(shopping, target, DownloadPurpose.OPEN, any()) } returns 70L
        val vm = viewModel()
        val seen = events(vm)
        vm.open(shopping); advanceUntilIdle()
        assertThat(seen).isEmpty()

        // Someone else's finished download is not this tap's.
        finished.emit(done(71L, DownloadPurpose.OPEN, "content://cache/other.txt"))
        finished.emit(done(70L, DownloadPurpose.OPEN, "content://cache/shopping.txt"))
        advanceUntilIdle()

        assertThat(seen).containsExactly(DriveEvent.View("content://cache/shopping.txt", "text/plain"))
    }

    @Test
    fun `share hands the downloaded file to the share sheet`() = runTest(dispatcher) {
        val target = mockk<DownloadTarget>()
        every { files.cacheTarget(shopping) } returns target
        every { transfers.download(shopping, target, DownloadPurpose.SHARE, any()) } returns 80L
        val vm = viewModel()
        val seen = events(vm)
        vm.share(shopping); advanceUntilIdle()
        finished.emit(done(80L, DownloadPurpose.SHARE, "content://cache/shopping.txt"))
        advanceUntilIdle()

        assertThat(seen).containsExactly(DriveEvent.Share("content://cache/shopping.txt", "text/plain"))
    }

    @Test
    fun `save to phone downloads into the document the user chose`() = runTest(dispatcher) {
        val target = mockk<DownloadTarget>()
        every { files.documentTarget("content://docs/shopping.txt") } returns target
        val vm = viewModel()
        vm.saveToPhone(shopping, "content://docs/shopping.txt"); advanceUntilIdle()

        verify { transfers.download(shopping, target, DownloadPurpose.SAVE, "this phone") }
    }

    @Test
    fun `a new folder is made in the open folder, and a refusal is the server's sentence`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        vm.showNewFolder()
        assertThat(vm.state.value.dialog).isEqualTo(DriveDialog.NewFolder())

        coEvery { repo.createFolder(5, "Archive") } throws http(409, "'Archive' already exists here")
        vm.createFolder("Archive"); advanceUntilIdle()
        assertThat(vm.state.value.dialog).isEqualTo(DriveDialog.NewFolder(error = "'Archive' already exists here"))

        coEvery { repo.createFolder(5, "2026") } returns DriveNode(id = 30, parentId = 5, name = "2026", isDir = true)
        vm.createFolder("2026"); advanceUntilIdle()
        assertThat(vm.state.value.dialog).isNull()
        coVerify(atLeast = 2) { repo.list(5) }
    }

    @Test
    fun `rename sends the new name, and an unchanged one sends nothing`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.startRename(shopping)
        assertThat(vm.state.value.dialog).isEqualTo(DriveDialog.Rename(shopping))
        vm.rename("shopping.txt"); advanceUntilIdle()
        coVerify(exactly = 0) { repo.rename(any(), any()) }
        assertThat(vm.state.value.dialog).isNull()

        vm.startRename(shopping)
        coEvery { repo.rename(7, "groceries.txt") } returns shopping.copy(name = "groceries.txt")
        vm.rename("  groceries.txt "); advanceUntilIdle()
        coVerify { repo.rename(7, "groceries.txt") }
        assertThat(vm.state.value.dialog).isNull()
    }

    @Test
    fun `delete asks first, then deletes and refreshes the storage card`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.startDelete(reports)
        assertThat(vm.state.value.dialog).isEqualTo(DriveDialog.Delete(reports))
        coVerify(exactly = 0) { repo.delete(any()) }

        vm.confirmDelete(); advanceUntilIdle()
        coVerify { repo.delete(5) }
        assertThat(vm.state.value.dialog).isNull()
        coVerify(atLeast = 2) { repo.usage() }
    }

    @Test
    fun `move browses folders from where the file is, and moves it where the user stops`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        vm.startMove(q3); advanceUntilIdle()

        with(vm.state.value.move!!) {
            assertThat(path).containsExactly(DRIVE_ROOT, DriveCrumb(5, "Reports")).inOrder()
            assertThat(folders.map { it.name }).containsExactly("Archive")
            assertThat(canMoveHere).isFalse()
        }

        vm.moveInto(archive); advanceUntilIdle()
        assertThat(vm.state.value.move!!.path.last()).isEqualTo(DriveCrumb(20, "Archive"))
        assertThat(vm.state.value.move!!.canMoveHere).isTrue()

        vm.moveHere(); advanceUntilIdle()
        coVerify { repo.move(21, 20) }
        assertThat(vm.state.value.move).isNull()
    }

    @Test
    fun `a folder being moved is not offered as a place to move it to, and the root is`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.startMove(reports); advanceUntilIdle()
        assertThat(vm.state.value.move!!.folders.map { it.name }).containsExactly("Photos")

        vm.moveInto(photos); advanceUntilIdle()
        vm.moveGoTo(0); advanceUntilIdle()
        assertThat(vm.state.value.move!!.canMoveHere).isFalse()

        vm.open(reports); advanceUntilIdle()
        vm.startMove(archive); advanceUntilIdle()
        vm.moveGoTo(0); advanceUntilIdle()
        vm.moveHere(); advanceUntilIdle()
        coVerify { repo.move(20, null) }
    }

    @Test
    fun `a file whose name is free here is uploaded straight away`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        vm.upload(listOf("content://picked/notes.md")); advanceUntilIdle()

        verify { transfers.upload(any(), 5, "Drive › Reports", false, "notes.md") }
        assertThat(vm.state.value.dialog).isNull()
    }

    @Test
    fun `names already taken ask Replace, Keep both or Skip, and the answer can cover the rest`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        vm.upload(listOf("content://picked/budget.xlsx", "content://picked/new.txt", "content://picked/Q3 report.pdf"))
        advanceUntilIdle()

        verify { transfers.upload(any(), 5, any(), false, "new.txt") }
        assertThat(vm.state.value.dialog).isEqualTo(
            DriveDialog.Conflict(name = "budget.xlsx", keepBothName = "budget (1).xlsx", place = "Drive › Reports", others = 1),
        )

        vm.resolveConflict(ConflictChoice.KEEP_BOTH, forTheOthers = true); advanceUntilIdle()
        verify { transfers.upload(any(), 5, any(), false, "budget (1).xlsx") }
        verify { transfers.upload(any(), 5, any(), false, "Q3 report (1).pdf") }
        assertThat(vm.state.value.dialog).isNull()
    }

    @Test
    fun `replace overwrites, skip sends nothing, and each clash is asked on its own`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        vm.upload(listOf("content://picked/budget.xlsx", "content://picked/Q3 report.pdf")); advanceUntilIdle()

        vm.resolveConflict(ConflictChoice.REPLACE, forTheOthers = false); advanceUntilIdle()
        verify { transfers.upload(any(), 5, any(), true, "budget.xlsx") }
        assertThat((vm.state.value.dialog as DriveDialog.Conflict).name).isEqualTo("Q3 report.pdf")
        assertThat((vm.state.value.dialog as DriveDialog.Conflict).others).isEqualTo(0)

        vm.resolveConflict(ConflictChoice.SKIP, forTheOthers = false); advanceUntilIdle()
        verify(exactly = 0) { transfers.upload(any(), any(), any(), any(), "Q3 report.pdf") }
        verify(exactly = 0) { transfers.upload(any(), any(), any(), any(), "Q3 report (1).pdf") }
        assertThat(vm.state.value.dialog).isNull()
    }

    @Test
    fun `an upload finishing in the open folder reloads it and the storage card`() = runTest(dispatcher) {
        val vm = viewModel()
        vm.open(reports); advanceUntilIdle()
        finished.emit(
            DriveTransfer(id = 1, direction = TransferDirection.UP, name = "notes.md", totalBytes = 3, transferredBytes = 3,
                status = TransferStatus.DONE, place = "Drive › Reports", folderId = 5, nodeId = 40),
        )
        advanceUntilIdle()

        coVerify(atLeast = 2) { repo.list(5) }
        coVerify(atLeast = 2) { repo.usage() }
    }

    @Test
    fun `the assistant's access changes the account's permission mode, and a refusal puts it back`() = runTest(dispatcher) {
        coEvery { assistants.updateAssistant(AssistantUpdate(permissionMode = PermissionMode.FULL)) } returns
            Assistant(id = 1, permissionMode = PermissionMode.FULL)
        val vm = viewModel()
        vm.showPermissionMode()
        assertThat(vm.state.value.dialog).isEqualTo(DriveDialog.PermissionModePicker)

        vm.setPermissionMode(PermissionMode.FULL); advanceUntilIdle()
        assertThat(vm.state.value.permissionMode).isEqualTo(PermissionMode.FULL)
        assertThat(vm.state.value.dialog).isNull()

        coEvery { assistants.updateAssistant(any()) } throws http(500, "no")
        vm.setPermissionMode(PermissionMode.ASK); advanceUntilIdle()
        assertThat(vm.state.value.permissionMode).isEqualTo(PermissionMode.FULL)
        assertThat(vm.state.value.message).isEqualTo("Could not change the permission mode")
    }

    private fun done(id: Long, purpose: DownloadPurpose, uri: String) = DriveTransfer(
        id = id, direction = TransferDirection.DOWN, name = "shopping.txt", totalBytes = 10, transferredBytes = 10,
        status = TransferStatus.DONE, place = "this phone", nodeId = 7, purpose = purpose, mime = "text/plain", resultUri = uri,
    )
}
