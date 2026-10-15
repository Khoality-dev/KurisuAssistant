package com.kurisu.assistant.data.remote.websocket

import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.remote.api.KurisuApiService
import com.kurisu.assistant.domain.notifications.notificationsUrl
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The phone's line to its notifications: `/ws/notifications` (#353).
 *
 * The server keeps every notification and whether it has been read; this
 * socket only tells the phone what changed: what is unread on connect, then
 * each new notification and each read, as [messages] for
 * `NotificationRepository` to make sense of. Not the chat socket — the chat is
 * last-one-wins, so the phone holding it would close the desktop's. This one
 * any number of devices hold at once, and [NotificationService] keeps it open
 * with the app closed.
 *
 * The token rides the shared client's `AuthInterceptor`, as on the chat
 * socket, and `WireProtocolInterceptor` stamps the protocol header. A refused
 * token (4001) is refreshed by an ordinary authenticated call, which the
 * interceptor answers by refreshing; a protocol mismatch (4426) ends it.
 */
@Singleton
class NotificationSocket @Inject constructor(
    okHttpClient: OkHttpClient,
    private val prefs: PreferencesDataStore,
    private val api: KurisuApiService,
) {
    companion object {
        private const val TAG = "NotificationSocket"
        private const val AUTH_FAILED = 4001
        private const val WIRE_PROTOCOL_MISMATCH = 4426
        private const val MAX_BACKOFF_MS = 30_000L
        private const val AUTH_BACKOFF_MS = 5 * 60_000L
    }

    private val client: OkHttpClient = okHttpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 64)
    val messages: SharedFlow<String> = _messages

    private var job: Job? = null
    @Volatile private var socket: WebSocket? = null

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch { run() }
    }

    fun stop() {
        job?.cancel()
        job = null
        socket?.close(1000, "Client disconnect")
        socket = null
    }

    private suspend fun CoroutineScope.run() {
        var backoff = 1_000L
        while (isActive) {
            val baseUrl = prefs.getBackendUrl()
            val closed = CompletableDeferred<Int>()
            var opened = false

            val request = Request.Builder().url(notificationsUrl(baseUrl)).build()
            socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened = true
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    _messages.tryEmit(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    closed.complete(code)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "Notifications socket failed: ${t.message}")
                    closed.complete(-1)
                }
            })

            val code = closed.await()
            socket = null
            if (opened) backoff = 1_000L
            when (code) {
                WIRE_PROTOCOL_MISMATCH -> {
                    // The app's update gate says so; retrying cannot help.
                    Log.w(TAG, "Notifications socket refused: wire protocol mismatch")
                    return
                }
                AUTH_FAILED -> {
                    val refreshed = try {
                        api.getUserProfile()
                        true
                    } catch (e: Exception) {
                        Log.w(TAG, "Could not refresh the session for notifications: ${e.message}")
                        false
                    }
                    delay(if (refreshed) 1_000L else AUTH_BACKOFF_MS)
                }
                else -> {
                    delay(backoff)
                    backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
                }
            }
        }
    }
}
