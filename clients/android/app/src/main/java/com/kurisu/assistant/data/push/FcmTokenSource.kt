package com.kurisu.assistant.data.push

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/** This app's FCM token, or null when the build has no Firebase (#353). */
interface FcmTokenSource {
    suspend fun token(): String?
}

/**
 * The token from Firebase Messaging. A build without `google-services.json`
 * initialises no Firebase app — CI, forks, local builds — and has no token:
 * the app works, with no background push.
 */
@Singleton
class FirebaseTokenSource @Inject constructor(
    @ApplicationContext private val context: Context,
) : FcmTokenSource {
    override suspend fun token(): String? {
        if (FirebaseApp.getApps(context).isEmpty()) return null
        return suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    continuation.resume(task.result)
                } else {
                    Log.w("FirebaseTokenSource", "No FCM token: ${task.exception?.message}")
                    continuation.resume(null)
                }
            }
        }
    }
}
