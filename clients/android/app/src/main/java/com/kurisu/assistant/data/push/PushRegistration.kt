package com.kurisu.assistant.data.push

import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.DeviceRegistration
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * This phone's registration for push through Firebase Cloud Messaging (#353).
 *
 * While its notifications are on and someone is signed in, the server has this
 * app's FCM token (`POST /notifications/devices`) and pushes each notification
 * and each read to it; turning them off, or signing out, takes it away. The
 * token registered is remembered so a new one from FCM ([onNewToken]) can
 * replace it, and so it can be removed even when Firebase would hand out
 * another. Nothing here fails the app: a server or a Firebase that will not
 * answer leaves the phone unregistered, and it catches up when the app opens.
 */
@Singleton
class PushRegistration @Inject constructor(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
    private val tokens: FcmTokenSource,
) {
    companion object {
        private const val TAG = "PushRegistration"
        const val PLATFORM = "android"
    }

    suspend fun register() {
        val token = tokens.token() ?: return
        send(token)
    }

    suspend fun unregister() {
        val token = prefs.getRegisteredPushToken() ?: return
        try {
            api.deleteNotificationDevice(token)
        } catch (e: Exception) {
            Log.w(TAG, "Could not unregister this phone: ${e.message}")
        }
        prefs.setRegisteredPushToken(null)
    }

    /** FCM issued a new token: replace the registered one, if this phone is registered. */
    suspend fun onNewToken(token: String) {
        val previous = prefs.getRegisteredPushToken() ?: return
        if (previous == token) return
        if (send(token)) {
            try {
                api.deleteNotificationDevice(previous)
            } catch (e: Exception) {
                Log.w(TAG, "Could not remove the old token: ${e.message}")
            }
        }
    }

    private suspend fun send(token: String): Boolean = try {
        api.registerNotificationDevice(DeviceRegistration(platform = PLATFORM, fcmToken = token))
        prefs.setRegisteredPushToken(token)
        true
    } catch (e: Exception) {
        Log.w(TAG, "Could not register this phone for push: ${e.message}")
        false
    }
}
