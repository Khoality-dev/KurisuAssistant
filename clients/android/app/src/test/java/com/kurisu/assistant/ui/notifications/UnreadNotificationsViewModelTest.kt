package com.kurisu.assistant.ui.notifications

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.data.repository.NotificationRepository
import com.kurisu.assistant.domain.notifications.NotificationTarget
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * The bell on the Chats screen and the unread list it opens (#353): the
 * server's count and list; opening an item reads it and says where it points;
 * "Mark all read" reads them all — on every device.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class UnreadNotificationsViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var repository: NotificationRepository
    private val unread = MutableStateFlow<List<NotificationEvent>>(emptyList())
    private val count = MutableStateFlow(0)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repository = mockk(relaxed = true)
        every { repository.unread } returns unread
        every { repository.unreadCount } returns count
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `shows the server's count and list, fetched when it opens`() = runTest(dispatcher) {
        val laundry = NotificationEvent(id = 2, sender = "Kurisu", title = "Laundry", conversationId = 7)
        unread.value = listOf(laundry)
        count.value = 3
        val vm = UnreadNotificationsViewModel(repository)
        advanceUntilIdle()
        assertThat(vm.unread.value).containsExactly(laundry)
        assertThat(vm.unreadCount.value).isEqualTo(3)
        coVerify { repository.refresh() }
    }

    @Test
    fun `opening one reads it and says where to go`() = runTest(dispatcher) {
        val vm = UnreadNotificationsViewModel(repository)
        val target = vm.open(NotificationEvent(id = 2, sender = "Kurisu", title = "Laundry", conversationId = 7))
        advanceUntilIdle()
        assertThat(target).isEqualTo(NotificationTarget.Conversation(7))
        coVerify { repository.markRead(2) }
    }

    @Test
    fun `reads them all`() = runTest(dispatcher) {
        val vm = UnreadNotificationsViewModel(repository)
        vm.markAllRead()
        advanceUntilIdle()
        coVerify { repository.markAllRead() }
    }
}
