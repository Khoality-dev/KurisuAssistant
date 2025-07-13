package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.kurisuassistant.android.utils.Util
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONObject

/**
 * Agent communicating with the REST API instead of a WebSocket.
 */
class Agent(private val player: AudioTrack) {
    private val modelName = "gemma3:12b-it-qat-tool"
    private val TAG = "Agent"
    private val client = OkHttpClient()
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
            .url("${BuildConfig.API_URL}/asr")
            .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
            .post(ByteString.of(*data).toByteArray().toRequestBody("application/octet-stream".toMediaType()))
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw Exception("ASR failed")
            val json = JSONObject(resp.body!!.string())
            return json.getString("text")
        }
    }

    private fun tts(text: String): ByteArray? {
        val body = JSONObject().put("text", text).toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${BuildConfig.API_URL}/tts")
            .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
            .post(body)
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) return null
            return resp.body!!.bytes()
        }
    }

    fun chat(text: String): Channel<String> {
        val channel = Channel<String>(Channel.UNLIMITED)
        chatChannel = channel
        _typing.postValue(true)
        scope.launch {
            val payload = JSONObject().apply {
                put("model", modelName)
                put("stream", true)
                put("message", JSONObject().apply {
                    put("role", "user")
                    put("content", text)
                })
            }
            val request = Request.Builder()
                .url("${BuildConfig.API_URL}/chat")
                .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
                .post(payload.toString().toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(request).execute().use { resp ->
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
                channel.close()
                _typing.postValue(false)
            }
        }
        return channel
    }
}
