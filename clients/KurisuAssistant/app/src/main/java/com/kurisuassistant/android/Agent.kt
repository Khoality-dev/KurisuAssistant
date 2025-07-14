package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.Settings
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.MediaType.Companion.toMediaType
import com.kurisuassistant.android.utils.HttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONObject

/**
 * Agent communicating with the REST API instead of a WebSocket.
 */
class Agent(private val player: AudioTrack) {
    private val TAG = "Agent"
    private val client = HttpClient.noTimeoutClient()
    private val scope = CoroutineScope(Dispatchers.IO)
    private var speakingJob: Job? = null

    private var chatChannel: Channel<String>? = null
    private val _connected = MutableLiveData(true)
    val connected: LiveData<Boolean> get() = _connected
    private val _typing = MutableLiveData(false)
    val typing: LiveData<Boolean> get() = _typing
    private val _speaking = MutableLiveData(false)
    val speaking: LiveData<Boolean> get() = _speaking

    suspend fun stt(audioBuffer: MutableIntList): String {
        val data = Util.toByteArray(audioBuffer)
        val request = Request.Builder()
            .url("${Settings.llmUrl}/asr")
            .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
            .post(ByteString.of(*data).toByteArray().toRequestBody("application/octet-stream".toMediaType()))
            .build()
        try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) throw Exception("ASR failed")
                val json = JSONObject(resp.body!!.string())
                return json.getString("text")
            }
        } catch (e: Exception) {
            Log.e(TAG, "ASR failed", e)
            return ""
        }
    }

    private fun tts(text: String): ByteArray? {
        val body = JSONObject().put("text", text).toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${Settings.ttsUrl}/tts")
            .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
            .post(body)
            .build()
        return try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                resp.body!!.bytes()
            }
        } catch (e: Exception) {
            Log.e(TAG, "TTS failed", e)
            null
        }
    }

    fun chat(text: String): Channel<String> {
        val channel = Channel<String>(Channel.UNLIMITED)
        chatChannel = channel
        _typing.postValue(true)
        scope.launch {
            val payload = JSONObject().apply {
                put("model", Settings.model)
                put("stream", true)
                put("message", JSONObject().apply {
                    put("role", "user")
                    put("content", text)
                })
            }
            val request = Request.Builder()
                .url("${Settings.llmUrl}/chat")
                .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
                .post(payload.toString().toRequestBody("application/json".toMediaType()))
                .build()
            try {
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        _connected.postValue(false)
                        channel.close(Exception("HTTP ${resp.code}"))
                        _typing.postValue(false)
                        return@use
                    }
                    val source = resp.body!!.source()
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line()
                        if (line.isNullOrBlank()) continue
                        Log.d(TAG, line)
                        val json = JSONObject(line)
                        val content = json.getJSONObject("message").getString("content")
                        channel.trySend(content)
                        val audio = tts(content)
                        if (audio != null) {
                            player.write(audio, 0, audio.size)
                            _speaking.postValue(true)
                            speakingJob?.cancel()
                            speakingJob = scope.launch {
                                delay(300)
                                _speaking.postValue(false)
                            }
                        }
                        if (json.optBoolean("done")) break
                    }
                    _connected.postValue(true)
                }
                channel.close()
                _typing.postValue(false)
            } catch (e: Exception) {
                Log.e(TAG, "Chat failed", e)
                _connected.postValue(false)
                channel.close(e)
                _typing.postValue(false)
            }
        }
        return channel
    }
}
