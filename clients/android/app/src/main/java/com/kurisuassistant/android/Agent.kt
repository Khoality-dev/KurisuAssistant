package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.kurisuassistant.android.utils.Util
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class Agent(val player: AudioTrack) {
    private val modelName = "gemma3:12b-it-qat-tool"
    private val TAG = "Agent"
    private var client: OkHttpClient
    private var webSocket: WebSocket? = null
    private var sttDeferred: CompletableDeferred<String>? = null
    private var chatChannel: Channel<String>? = null
    private val _connected = MutableLiveData(false)
    val connected: LiveData<Boolean> get() = _connected
    private val _typing = MutableLiveData(false)
    val typing: LiveData<Boolean> get() = _typing
    private val _speaking = MutableLiveData(false)
    val speaking: LiveData<Boolean> get() = _speaking
    private val scope = CoroutineScope(Dispatchers.IO)
    private var speakingJob: Job? = null

    init {
        client = OkHttpClient.Builder()
            // Keep the socket alive by sending ping frames periodically
            .pingInterval(30, TimeUnit.SECONDS)
            .build()

        connect()
    }

    /**
     * Establish a new WebSocket connection using [client]. This function also
     * registers the default [WebSocketListener] that streams received PCM data
     * directly into [player].
     */
    private fun connect() {
        val request = Request.Builder()
            .url(BuildConfig.WS_API_URL)
            .build()

        _connected.postValue(false)

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                super.onOpen(webSocket, response)
                Log.d(TAG, "WebSocket opened: ${response.request.url}")
                // Authenticate with API token
                webSocket.send(BuildConfig.API_TOKEN)
                _connected.postValue(true)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                super.onMessage(webSocket, bytes)
                // Stream PCM data directly to the audio player
                val pcmChunk = bytes.toByteArray()
                player.write(pcmChunk, 0, pcmChunk.size)
                _speaking.postValue(true)
                speakingJob?.cancel()
                speakingJob = scope.launch {
                    delay(300)
                    _speaking.postValue(false)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                super.onMessage(webSocket, text)
                Log.d(TAG, text)
                val json = JSONObject(text)
                if (json.has("text")) {
                    // Result from server-side ASR. Complete the pending STT
                    // request and forward the text for LLM inference.
                    val transcript = json.getString("text")
                    sttDeferred?.complete(transcript)
                    sttDeferred = null
                    // The service will call [chat] with this transcript to get
                    // assistant responses.
                } else if (json.has("message")) {
                    val content = json.getJSONObject("message").getString("content")
                    chatChannel?.trySend(content)
                    if (json.optBoolean("done")) {
                        chatChannel?.close()
                        chatChannel = null
                        _typing.postValue(false)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                super.onClosing(webSocket, code, reason)
                Log.d(TAG, "WebSocket closing: $code / $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                super.onClosed(webSocket, code, reason)
                Log.d(TAG, "WebSocket closed: $code / $reason")
                _connected.postValue(false)
                _typing.postValue(false)
                _speaking.postValue(false)
                reconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                super.onFailure(webSocket, t, response)
                Log.e(TAG, "WebSocket failure: ${t.localizedMessage}", t)
                _connected.postValue(false)
                _typing.postValue(false)
                _speaking.postValue(false)
                reconnect()
            }
        }

        // 6. Open WebSocket
        webSocket = client.newWebSocket(request, listener)
    }

    /**
     * Try to re-establish the WebSocket connection after a failure or when the
     * server closes the socket. This will wait a short delay before calling
     * [connect] again.
     */
    private fun reconnect() {
        webSocket = null
        _connected.postValue(false)
        // Simple reconnection strategy. In a real app this could include
        // exponential backoff.
        Thread {
            try {
                Thread.sleep(1000)
            } catch (_: InterruptedException) {
            }
            connect()
        }.start()
    }

    suspend fun stt(audioBuffer: MutableIntList): String {
        val data = Util.toByteArray(audioBuffer)
        val deferred = CompletableDeferred<String>()
        sttDeferred = deferred
        webSocket?.send(ByteString.of(*data))
        return deferred.await()
    }
//

    fun chat(text: String): Channel<String> {
        val channel = Channel<String>(Channel.UNLIMITED)
        chatChannel = channel
        _typing.postValue(true)
        val json = JSONObject().apply {
            put("model", modelName)
            put("stream", true)
            put("message", JSONObject().apply {
                put("role", "user")
                put("content", text)
            })
        }
        webSocket?.send(json.toString())
        return channel
    }

}
