package com.kurisu.assistant.data.repository

import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.NotificationEvent
import com.kurisu.assistant.data.model.NotificationReadFor
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.domain.notifications.NotificationChanges
import com.kurisu.assistant.domain.notifications.NotificationSync
import com.kurisu.assistant.service.CoreState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The phone's view of the server's notifications (#353).
 *
 * The server keeps every notification and whether it has been read; the phone
 * only displays them. [apply] takes each `/ws/notifications` message and says
 * what to post and what to cancel, remembering what was posted (per server, the
 * one piece of notification state kept here). Reading is the server's to
 * record: one ([markRead]), all ([markAllRead]), or every one pointing at the
 * conversation the user just opened — watched here on [CoreState], so it holds
 * however the conversation was opened. The server then tells every device.
 */
@Singleton
class NotificationRepository(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
    coreState: CoreState,
    private val scope: CoroutineScope,
) {
    @Inject
    constructor(api: KurisuApiService, prefs: PreferencesDataStore, coreState: CoreState) :
        this(api, prefs, coreState, CoroutineScope(SupervisorJob() + Dispatchers.IO))

    companion object {
        private const val TAG = "NotificationRepository"
    }

    private val _unread = MutableStateFlow<List<NotificationEvent>>(emptyList())
    /** What the server says is unread, newest first (the newest 50) — the bell's list. */
    val unread: StateFlow<List<NotificationEvent>> = _unread

    private val _unreadCount = MutableStateFlow(0)
    /** How many the server says are unread — the bell's badge. */
    val unreadCount: StateFlow<Int> = _unreadCount

    private val lock = Mutex()
    private var sync: NotificationSync? = null
    private var server: String? = null

    init {
        scope.launch {
            coreState.state.map { it.conversationId }.distinctUntilChanged().collect { id ->
                if (id != null && _unread.value.any { it.conversationId == id }) {
                    call("read what points at a conversation") {
                        api.markNotificationsReadFor(NotificationReadFor(conversationId = id))
                    }
                }
            }
        }
    }

    /**
     * One socket message: what to post and what to cancel. Anything that
     * arrived or was read also fetches the bell's list and count again.
     */
    suspend fun apply(text: String): NotificationChanges {
        val changes = lock.withLock {
            val current = syncFor(prefs.getBackendUrl())
            val changes = current.handle(text)
            if (!changes.isEmpty()) prefs.setShownNotifications(server!!, current.shown)
            changes
        }
        if (text.contains("\"type\"")) scope.launch { refresh() }
        return changes
    }

    /** A Firebase data message (#353): what to post and what to cancel, as for the socket. */
    suspend fun applyPush(data: Map<String, String>): NotificationChanges {
        val changes = lock.withLock {
            val current = syncFor(prefs.getBackendUrl())
            val changes = current.handlePush(data)
            if (!changes.isEmpty()) prefs.setShownNotifications(server!!, current.shown)
            changes
        }
        if (!changes.isEmpty()) scope.launch { refresh() }
        return changes
    }

    /** The bell's list and count, from the server — the socket need not be open. */
    suspend fun refresh() {
        val list = call("list notifications") { api.listNotifications(unread = true, limit = 50) } ?: return
        _unread.value = list.notifications
        _unreadCount.value = list.unreadCount
    }

    suspend fun markRead(id: Int) {
        call("mark one read") { api.markNotificationRead(id) }
    }

    suspend fun markAllRead() {
        call("mark them read") { api.markAllNotificationsRead() }
    }

    private suspend fun syncFor(baseUrl: String): NotificationSync {
        val existing = sync
        if (existing != null && server == baseUrl) return existing
        server = baseUrl
        return NotificationSync(prefs.getShownNotifications(baseUrl)).also { sync = it }
    }

    private suspend fun <T> call(what: String, block: suspend () -> T): T? = try {
        block()
    } catch (e: Exception) {
        Log.w(TAG, "Could not $what: ${e.message}")
        null
    }
}
