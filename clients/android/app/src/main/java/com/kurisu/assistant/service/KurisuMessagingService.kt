package com.kurisu.assistant.service

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.kurisu.assistant.data.push.PushRegistration
import com.kurisu.assistant.data.repository.NotificationRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import javax.inject.Inject

/**
 * Notifications with the app closed, through Firebase Cloud Messaging (#353).
 *
 * The server sends *data* messages, high priority: `notification` is built
 * into a system notification here — the same look as one from the socket —
 * and `notifications_read` cancels those ids. Both go through
 * `NotificationRepository`, so one that also arrives on the socket while the
 * app is open is posted once. A new FCM token replaces the registered one.
 */
@AndroidEntryPoint
class KurisuMessagingService : FirebaseMessagingService() {

    @Inject lateinit var repository: NotificationRepository
    @Inject lateinit var poster: NotificationPoster
    @Inject lateinit var pushRegistration: PushRegistration

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(message: RemoteMessage) {
        // FCM gives a data message a short window on a background thread; the
        // work is a local decision and a post, so it is done before returning.
        runBlocking { poster.apply(repository.applyPush(message.data)) }
    }

    override fun onNewToken(token: String) {
        scope.launch { pushRegistration.onNewToken(token) }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
