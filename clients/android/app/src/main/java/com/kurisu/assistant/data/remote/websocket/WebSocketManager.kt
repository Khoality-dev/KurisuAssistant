package com.kurisu.assistant.data.remote.websocket

import android.util.Log
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.*
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class WebSocketManager @Inject constructor(
    private val okHttpClient: OkHttpClient,
    private val preferencesDataStore: PreferencesDataStore,
) {
    companion object {
        private const val TAG = "WebSocketManager"
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // WebSocket client — derived from shared client, no read/write timeouts
    private val wsClient: OkHttpClient = okHttpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var ws: WebSocket? = null
    private var token: String? = null
    private var reconnectAttempts = 0
    private val reconnectDelay = 1000L
    private val maxReconnectDelay = 10_000L
    private var intentionalClose = false
    @Volatile private var isConnected = false

    private val connectMutex = Mutex()

    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events

    fun setToken(token: String) {
        Log.d(TAG, "setToken called")
        this.token = token
    }

    fun clearToken() {
        this.token = null
    }

    suspend fun connect() {
        Log.d(TAG, "connect() called, isConnected=$isConnected, ws=${ws != null}")
        if (isConnected) return

        connectMutex.withLock {
            if (isConnected) return

            val currentToken = token
            if (currentToken == null) {
                Log.e(TAG, "connect() failed — no token")
                throw IllegalStateException("No authentication token set")
            }
            intentionalClose = false

            val baseUrl = preferencesDataStore.getBackendUrl()
            val wsUrl = baseUrl
                .replace(Regex("^http:"), "ws:")
                .replace(Regex("^https:"), "wss:")
            val url = "$wsUrl/ws/chat?token=${java.net.URLEncoder.encode(currentToken, "UTF-8")}"
            Log.d(TAG, "connect() opening WebSocket to $wsUrl/ws/chat")
            val request = Request.Builder().url(url).build()

            val deferred = CompletableDeferred<Unit>()

            Log.d(TAG, "connect() creating WebSocket...")
            val webSocket = wsClient.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.d(TAG, "WebSocket onOpen — connected, response=${response.code}")
                    reconnectAttempts = 0
                    isConnected = true
                    deferred.complete(Unit)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val jsonElement = json.parseToJsonElement(text)
                        val type = jsonElement.jsonObject["type"]?.jsonPrimitive?.content
                        // Silently handle ping/pong
                        if (type == "ping") {
                            webSocket.send("""{"type":"pong"}""")
                            return
                        }
                        if (type == "pong") return

                        val event = parseServerEvent(text)
                        if (event != null) {
                            _events.tryEmit(event)
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to parse WS message: ${e.message}")
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(TAG, "WebSocket onFailure: ${t.message}", t)
                    Log.e(TAG, "onFailure response: ${response?.code} ${response?.message}")
                    val wasConnected = isConnected
                    isConnected = false
                    ws = null

                    deferred.completeExceptionally(t)

                    if (wasConnected && !intentionalClose && token != null) {
                        emitConnectionLostError()
                        attemptReconnect()
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "WebSocket onClosed: code=$code reason=$reason")
                    val wasConnected = isConnected
                    isConnected = false
                    ws = null

                    deferred.completeExceptionally(Exception("WebSocket closed: $code $reason"))

                    if (wasConnected && !intentionalClose && token != null) {
                        emitConnectionLostError()
                        attemptReconnect()
                    }
                }
            })
            ws = webSocket

            try {
                withTimeout(15_000) {
                    deferred.await()
                }
                Log.d(TAG, "connect() completed successfully")
            } catch (e: Exception) {
                Log.e(TAG, "connect() failed: ${e.message}")
                ws?.close(1000, "Connect failed")
                ws = null
                throw e
            }
        }
    }

    fun disconnect() {
        Log.d(TAG, "disconnect() called")
        intentionalClose = true
        ws?.close(1000, "Client disconnect")
        ws = null
        isConnected = false
        reconnectAttempts = 0
    }

    fun isConnected(): Boolean = isConnected

    private fun send(payload: String) {
        val socket = ws ?: throw IllegalStateException("WebSocket not connected")
        socket.send(payload)
    }

    private fun generateEventId(): String = UUID.randomUUID().toString()
    private fun nowTimestamp(): String = Instant.now().toString()

    suspend fun sendChatRequest(
        text: String,
        modelName: String,
        conversationId: Int? = null,
        agentId: Int? = null,
        images: List<String> = emptyList(),
    ) {
        Log.d(TAG, "sendChatRequest: text='${text.take(50)}' agentId=$agentId convId=$conversationId")
        ensureConnected()
        val payload = ChatRequestPayload(
            eventId = generateEventId(),
            timestamp = nowTimestamp(),
            text = text,
            modelName = modelName,
            conversationId = conversationId,
            agentId = agentId,
            images = images,
        )
        send(json.encodeToString(ChatRequestPayload.serializer(), payload))
    }

    fun sendCancel() {
        if (!isConnected) return
        val payload = CancelPayload(eventId = generateEventId(), timestamp = nowTimestamp())
        send(json.encodeToString(CancelPayload.serializer(), payload))
    }

    suspend fun sendVisionStart(enableFace: Boolean = true, enablePose: Boolean = true, enableHands: Boolean = true) {
        ensureConnected()
        val payload = VisionStartPayload(
            eventId = generateEventId(),
            timestamp = nowTimestamp(),
            enableFace = enableFace,
            enablePose = enablePose,
            enableHands = enableHands,
        )
        send(json.encodeToString(VisionStartPayload.serializer(), payload))
    }

    fun sendVisionFrame(frameBase64: String) {
        if (!isConnected) return
        val payload = VisionFramePayload(
            eventId = generateEventId(),
            timestamp = nowTimestamp(),
            frame = frameBase64,
        )
        send(json.encodeToString(VisionFramePayload.serializer(), payload))
    }

    fun sendVisionStop() {
        if (!isConnected) return
        val payload = VisionStopPayload(eventId = generateEventId(), timestamp = nowTimestamp())
        send(json.encodeToString(VisionStopPayload.serializer(), payload))
    }

    fun sendToolApprovalResponse(approvalId: String, approved: Boolean) {
        if (!isConnected) return
        val payload = ToolApprovalResponsePayload(
            eventId = generateEventId(),
            timestamp = nowTimestamp(),
            approvalId = approvalId,
            approved = approved,
        )
        send(json.encodeToString(ToolApprovalResponsePayload.serializer(), payload))
    }

    private suspend fun ensureConnected() {
        if (!isConnected) {
            Log.d(TAG, "ensureConnected: not connected, calling connect()")
            connect()
        }
    }

    private fun parseServerEvent(text: String): ServerEvent? {
        val jsonElement = json.parseToJsonElement(text)
        val type = jsonElement.jsonObject["type"]?.jsonPrimitive?.content ?: return null

        return when (type) {
            "stream_chunk" -> json.decodeFromString<StreamChunkEvent>(text)
            "agent_switch" -> json.decodeFromString<AgentSwitchEvent>(text)
            "done" -> json.decodeFromString<DoneEvent>(text)
            "error" -> json.decodeFromString<ErrorEvent>(text)
            "tool_approval_request" -> json.decodeFromString<ToolApprovalRequestEvent>(text)
            "vision_result" -> json.decodeFromString<VisionResultEvent>(text)
            "media_state" -> json.decodeFromString<MediaStateEvent>(text)
            "media_chunk" -> json.decodeFromString<MediaChunkEvent>(text)
            "media_error" -> json.decodeFromString<MediaErrorEvent>(text)
            "reconnected" -> json.decodeFromString<ReconnectedEvent>(text)
            else -> {
                Log.w(TAG, "Unknown event type: $type")
                null
            }
        }
    }

    private fun emitConnectionLostError() {
        _events.tryEmit(ErrorEvent(
            eventId = "",
            timestamp = nowTimestamp(),
            error = "Connection lost. Reconnecting...",
            code = "CONNECTION_LOST",
        ))
    }

    private fun attemptReconnect() {
        if (intentionalClose || token == null) return
        reconnectAttempts++
        val delay = (reconnectDelay * Math.pow(2.0, (reconnectAttempts - 1).toDouble()))
            .toLong()
            .coerceAtMost(maxReconnectDelay)
        Log.d(TAG, "Reconnecting in ${delay}ms (attempt $reconnectAttempts)")

        scope.launch {
            delay(delay)
            if (token != null && !isConnected && !intentionalClose) {
                try {
                    connect()
                    _events.tryEmit(ReconnectedEvent(
                        eventId = "",
                        timestamp = nowTimestamp(),
                    ))
                } catch (_: Exception) {
                    attemptReconnect()
                }
            }
        }
    }
}

private val kotlinx.serialization.json.JsonElement.jsonObject
    get() = this as kotlinx.serialization.json.JsonObject
