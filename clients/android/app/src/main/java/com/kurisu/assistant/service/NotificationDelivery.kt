package com.kurisu.assistant.service

import com.kurisu.assistant.data.push.PushRegistration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/** Notifications on or off for this phone, behind an interface the settings screen's tests can fake. */
interface NotificationDelivery {
    fun start()
    fun stop()
}

/**
 * On: register this phone for push, and listen on the socket while the app is
 * open. Off: unregister it, and stop listening (#353).
 */
@Singleton
class AndroidNotificationDelivery @Inject constructor(
    private val pushRegistration: PushRegistration,
    private val foreground: ForegroundNotifications,
) : NotificationDelivery {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun start() {
        scope.launch { pushRegistration.register() }
        foreground.setEnabled(true)
    }

    override fun stop() {
        scope.launch { pushRegistration.unregister() }
        foreground.setEnabled(false)
    }
}
