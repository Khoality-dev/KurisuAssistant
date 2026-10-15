package com.kurisu.assistant.ui.tasks

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.ServerEvent
import com.kurisu.assistant.data.model.TaskApproval
import com.kurisu.assistant.data.model.TasksChangedEvent
import com.kurisu.assistant.data.remote.websocket.WebSocketManager
import com.kurisu.assistant.data.repository.TaskRepository
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

/**
 * A task run's conversation can be waiting on the user to approve a call (#352).
 * No live turn is attached to it, so the chat finds the approval over REST and
 * answers it there; the list follows `tasks_changed`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class TaskApprovalsViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: TaskRepository
    private lateinit var ws: WebSocketManager
    private val events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 8)
    private var server = listOf<TaskApproval>()

    private fun approval(id: Int, conversationId: Int) = TaskApproval(
        id = id, runId = 100 + id, taskId = 5, taskTitle = "Tidy", conversationId = conversationId,
        toolName = "drive_write", description = "Write /a",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        ws = mockk(relaxed = true)
        every { ws.events } returns events
        coEvery { repo.listApprovals() } answers { server }
        coEvery { repo.answerApproval(any(), any()) } answers {
            server = server.filterNot { it.id == firstArg<Int>() }
        }
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `finds the call a conversation waits on`() = runTest(dispatcher) {
        server = listOf(approval(9, 40))
        val vm = TaskApprovalsViewModel(repo, ws)
        advanceUntilIdle()
        assertThat(vm.forConversation(40)?.id).isEqualTo(9)
        assertThat(vm.forConversation(41)).isNull()
        assertThat(vm.forConversation(null)).isNull()
    }

    @Test
    fun `answering sends it and the call leaves`() = runTest(dispatcher) {
        server = listOf(approval(9, 40))
        val vm = TaskApprovalsViewModel(repo, ws)
        advanceUntilIdle()
        vm.answer(9, approved = false)
        advanceUntilIdle()
        coVerify { repo.answerApproval(9, false) }
        assertThat(vm.forConversation(40)).isNull()
    }

    @Test
    fun `a tasks_changed event refetches`() = runTest(dispatcher) {
        val vm = TaskApprovalsViewModel(repo, ws)
        advanceUntilIdle()
        assertThat(vm.forConversation(40)).isNull()
        server = listOf(approval(9, 40))
        events.emit(TasksChangedEvent(taskId = 5))
        advanceUntilIdle()
        assertThat(vm.forConversation(40)?.id).isEqualTo(9)
    }
}
