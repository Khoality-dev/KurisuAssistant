package com.kurisu.assistant.data.repository

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.data.model.NotificationList
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.service.CoreState
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test

/**
 * The phone's view of the server's notifications (#353): what is unread, and
 * reading — one, all, or every one pointing at a conversation the user just
 * opened. The server records each read and tells every device.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationRepositoryTest {

    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)
    private lateinit var api: KurisuApiService
    private lateinit var prefs: PreferencesDataStore
    private lateinit var coreState: CoreState

    private fun notification(id: Int, conversationId: Int? = null) =
        """{"type":"notification","id":$id,"source":"assistant","sender":"Kurisu","title":"n$id","body":"","conversation_id":${conversationId ?: "null"},"reminder_id":null,"created_at":"2026-10-16T08:02:00Z","read_at":null}"""

    @Before
    fun setUp() {
        api = mockk(relaxed = true)
        prefs = mockk(relaxed = true)
        coEvery { prefs.getBackendUrl() } returns "http://server"
        coEvery { prefs.getShownNotifications(any()) } returns emptySet()
        coreState = CoreState()
    }

    @Test
    fun `opening the conversation a notification points to reads it`() = runTest(dispatcher) {
        coEvery { api.listNotifications(unread = true, limit = 50) } returns NotificationList(
            notifications = listOf(
                NotificationEvent(id = 1, conversationId = 7),
                NotificationEvent(id = 2, conversationId = 8),
            ),
            unreadCount = 2,
        )
        val repository = NotificationRepository(api, prefs, coreState, scope)
        repository.apply("""{"type":"notifications_ready","unread":[${notification(1, 7)},${notification(2, 8)}]}""")
        advanceUntilIdle()

        coreState.setConversationId(7)
        advanceUntilIdle()
        coVerify(exactly = 1) { api.markNotificationsReadFor(match { it.conversationId == 7 }) }

        coreState.setConversationId(99)
        advanceUntilIdle()
        coVerify(exactly = 0) { api.markNotificationsReadFor(match { it.conversationId == 99 }) }
    }

    @Test
    fun `reading one or all goes to the server`() = runTest(dispatcher) {
        val repository = NotificationRepository(api, prefs, coreState, scope)
        repository.markRead(3)
        repository.markAllRead()
        coVerify { api.markNotificationRead(3) }
        coVerify { api.markAllNotificationsRead() }
    }

    @Test
    fun `what was posted is remembered for the next reconnect`() = runTest(dispatcher) {
        val repository = NotificationRepository(api, prefs, coreState, scope)
        val changes = repository.apply("""{"type":"notifications_ready","unread":[${notification(5)}]}""")
        advanceUntilIdle()
        assertThat(changes.post.map { it.id }).containsExactly(5)
        coVerify { prefs.setShownNotifications("http://server", setOf(5)) }
    }

    @Test
    fun `the unread list and its count are the server's, fetched again on every change`() = runTest(dispatcher) {
        coEvery { api.listNotifications(unread = true, limit = 50) } returns NotificationList(
            notifications = listOf(NotificationEvent(id = 9, sender = "Kurisu", title = "Laundry")),
            unreadCount = 12,
        )
        val repository = NotificationRepository(api, prefs, coreState, scope)
        repository.apply(notification(9))
        advanceUntilIdle()
        assertThat(repository.unread.value.map { it.id }).containsExactly(9)
        assertThat(repository.unreadCount.value).isEqualTo(12)

        repository.apply("""{"type":"notifications_read","ids":[9],"read_at":"2026-10-16T09:00:00Z"}""")
        advanceUntilIdle()
        coVerify(exactly = 2) { api.listNotifications(unread = true, limit = 50) }
    }
}
