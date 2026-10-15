package com.kurisu.assistant.ui.tasks

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.AssistantTask
import com.kurisu.assistant.data.model.ServerEvent
import com.kurisu.assistant.data.model.TasksChangedEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.TaskRepository
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * The Tasks screen (#352): tasks grouped by what they are doing, a filter, the
 * next run said as a person would, and a list that keeps up when a run starts
 * or ends with nobody watching.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class TasksViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: TaskRepository
    private lateinit var ws: WebSocketManager
    private lateinit var coreState: CoreState
    private val events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 8)
    private var serverTasks = listOf<AssistantTask>()

    private fun task(id: Int, status: String, title: String = "task $id") =
        AssistantTask(id = id, title = title, status = status, repeat = "daily", time = "08:00",
            scheduleLabel = "Every day at 08:00")

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        ws = mockk(relaxed = true)
        coreState = CoreState()
        every { ws.events } returns events
        coEvery { repo.listTasks() } answers { serverTasks }
        coEvery { repo.getTask(any()) } answers { serverTasks.first { it.id == firstArg<Int>() }.copy(runs = emptyList()) }
        coEvery { repo.setPaused(any(), any()) } answers {
            serverTasks.first { it.id == firstArg<Int>() }.copy(status = if (secondArg<Boolean>()) "paused" else "scheduled", runs = emptyList())
        }
        serverTasks = listOf(task(1, "paused"), task(2, "running"), task(3, "scheduled"), task(5, "scheduled"))
        coEvery { repo.listApprovals() } returns emptyList()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `groups waiting, running, scheduled, paused, and leaves out empty ones`() {
        val tasks = serverTasks + task(6, "waiting_for_approval") + task(4, "finished")
        val groups = groupTasks(tasks, "all")
        assertThat(groups.map { it.status })
            .containsExactly("waiting_for_approval", "running", "scheduled", "paused").inOrder()
        assertThat(groups[2].tasks.map { it.id }).containsExactly(3, 5).inOrder()
        assertThat(groups.map { it.label })
            .containsExactly("Waiting for approval", "Running", "Scheduled", "Paused").inOrder()
        assertThat(groupTasks(listOf(task(1, "paused")), "all").map { it.status }).containsExactly("paused")
        assertThat(groupTasks(tasks, "scheduled").map { it.status }).containsExactly("scheduled")
    }

    @Test
    fun `a finished one-off is not on the Tasks screen`() {
        val tasks = serverTasks + task(4, "finished")
        assertThat(groupTasks(tasks, "all").flatMap { it.tasks }.map { it.id }).doesNotContain(4)
        assertThat(TASK_FILTERS.map { it.first }).doesNotContain("finished")
    }

    @Test
    fun `answering a waiting call sends it and refetches`() = runTest(dispatcher) {
        coEvery { repo.answerApproval(any(), any()) } returns Unit
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        vm.answerApproval(9, approved = true)
        advanceUntilIdle()
        coVerify { repo.answerApproval(9, true) }
        coVerify(atLeast = 2) { repo.listTasks() }
    }

    @Test
    fun `the next run reads as today, tomorrow, a weekday or a date`() {
        val zone = ZoneId.of("Europe/Paris")
        val now = LocalDateTime.of(2026, 10, 13, 14, 20).atZone(zone)
        fun at(m: Int, d: Int, h: Int, min: Int) = LocalDateTime.of(2026, m, d, h, min).atZone(zone).toInstant().toString()
        assertThat(formatNextRun(at(10, 13, 18, 0), now)).isEqualTo("today 18:00")
        assertThat(formatNextRun(at(10, 14, 7, 30), now)).isEqualTo("tomorrow 07:30")
        assertThat(formatNextRun(at(10, 16, 19, 0), now)).isEqualTo("Fri 19:00")
        assertThat(formatNextRun(at(12, 4, 9, 0), now)).isEqualTo("Fri 4 Dec, 09:00")
        assertThat(formatNextRun(at(10, 13, 14, 0), now)).isEqualTo("due now")
        assertThat(formatNextRun(null, now)).isEqualTo("")
    }

    @Test
    fun `loads the tasks, and opening one fetches its runs`() = runTest(dispatcher) {
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        assertThat(vm.state.value.tasks.map { it.id }).containsExactly(1, 2, 3, 5)

        vm.open(3)
        advanceUntilIdle()
        assertThat(vm.state.value.selected?.id).isEqualTo(3)
        coVerify { repo.getTask(3) }
    }

    @Test
    fun `pausing updates the row and the open task`() = runTest(dispatcher) {
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        vm.open(3)
        advanceUntilIdle()
        vm.setPaused(3, true)
        advanceUntilIdle()
        assertThat(vm.state.value.tasks.first { it.id == 3 }.status).isEqualTo("paused")
        assertThat(vm.state.value.selected?.status).isEqualTo("paused")
    }

    @Test
    fun `deleting closes the task and drops its row`() = runTest(dispatcher) {
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        vm.open(3)
        advanceUntilIdle()
        vm.delete(3)
        advanceUntilIdle()
        coVerify { repo.deleteTask(3) }
        assertThat(vm.state.value.selected).isNull()
        assertThat(vm.state.value.tasks.map { it.id }).doesNotContain(3)
    }

    @Test
    fun `a tasks_changed event refetches the list and the open task`() = runTest(dispatcher) {
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        vm.open(3)
        advanceUntilIdle()

        serverTasks = serverTasks.map { if (it.id == 3) it.copy(status = "running") else it }
        events.emit(TasksChangedEvent(taskId = 3))
        advanceUntilIdle()

        assertThat(vm.state.value.tasks.first { it.id == 3 }.status).isEqualTo("running")
        assertThat(vm.state.value.selected?.status).isEqualTo("running")
    }

    @Test
    fun `opening a run puts its conversation on the chat`() = runTest(dispatcher) {
        val vm = TasksViewModel(repo, ws, coreState)
        advanceUntilIdle()
        vm.openConversation(42)
        assertThat(coreState.state.value.conversationId).isEqualTo(42)
    }
}
