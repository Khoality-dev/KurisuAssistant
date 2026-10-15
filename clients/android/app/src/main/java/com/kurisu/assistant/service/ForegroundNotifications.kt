package com.kurisu.assistant.service

import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.websocket.NotificationSocket
import com.kurisu.assistant.data.repository.NotificationRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The socket path while the app is open (#353). With the app closed, Firebase
 * pushes; open, the notifications socket gives the catch-up — what is unread,
 * what was read meanwhile — and everything as it happens, with no push service
 * in between. `MainActivity` starts it when it comes to the front and stops it
 * when it leaves; it only listens while this phone's notifications are on.
 */
@Singleton
class ForegroundNotifications @Inject constructor(
    private val socket: NotificationSocket,
    private val repository: NotificationRepository,
    private val poster: NotificationPoster,
    private val prefs: PreferencesDataStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var collector: Job? = null
    @Volatile private var inFront = false
    @Volatile private var enabled: Boolean? = null

    fun onAppStarted() {
        inFront = true
        reconcile()
    }

    fun onAppStopped() {
        inFront = false
        reconcile()
    }

    fun setEnabled(on: Boolean) {
        enabled = on
        reconcile()
    }

    private fun reconcile() {
        scope.launch {
            val on = enabled ?: prefs.getNotificationsEnabled()
            if (on && inFront) {
                if (collector?.isActive != true) {
                    collector = scope.launch { socket.messages.collect { poster.apply(repository.apply(it)) } }
                }
                socket.start(scope)
            } else {
                socket.stop()
                collector?.cancel()
                collector = null
            }
        }
    }
}
