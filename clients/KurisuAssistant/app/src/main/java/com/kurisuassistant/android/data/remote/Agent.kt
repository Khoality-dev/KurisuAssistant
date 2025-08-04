package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.Settings
import com.kurisuassistant.android.model.ChatMessage
import android.content.Context
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import okio.ByteString
import org.json.JSONObject

/**
 * Agent communicating with the REST API instead of a WebSocket.
 */
class Agent(private val player: AudioTrack) {
    private val TAG = "Agent"
    private val scope = CoroutineScope(Dispatchers.IO)
    private var speakingJob: Job? = null
    private var healthCheckJob: Job? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)  // Longer read timeout for streaming chat responses
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private var chatChannel: Channel<ChatMessage>? = null
    private val _connected = MutableLiveData(false)
    val connected: LiveData<Boolean> get() = _connected
    private val _typing = MutableLiveData(false)
    val typing: LiveData<Boolean> get() = _typing
    private val _speaking = MutableLiveData(false)
    val speaking: LiveData<Boolean> get() = _speaking

    init {
        startHealthCheck()
    }

    suspend fun stt(audioBuffer: MutableIntList): String {
        val data = Util.toByteArray(audioBuffer)
        val body = ByteString.of(*data).toByteArray().toRequestBody("application/octet-stream".toMediaType())
        try {
            val request = Request.Builder()
                .url("${Settings.llmUrl}/asr")
                .post(body)
                .addHeader("Authorization", "Bearer ${Auth.token}")
                .build()
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
        return try {
            val request = Request.Builder()
                .url("${Settings.ttsUrl}/tts")
                .post(body)
                .addHeader("Authorization", "Bearer ${Auth.token}")
                .build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                resp.body!!.bytes()
            }
        } catch (e: Exception) {
            Log.e(TAG, "TTS failed", e)
            null
        }
    }

    fun chat(text: String, conversationId: Int? = null): Channel<ChatMessage> {
        val channel = Channel<ChatMessage>(Channel.UNLIMITED)
        chatChannel = channel
        _typing.postValue(true)
        scope.launch {
            // Build the form data for the new endpoint
            val formData = StringBuilder()
            formData.append("text=").append(java.net.URLEncoder.encode(text, "UTF-8"))
            formData.append("&model_name=").append(java.net.URLEncoder.encode(Settings.model, "UTF-8"))
            conversationId?.let { 
                formData.append("&conversation_id=").append(it)
            }
            
            val body = formData.toString().toRequestBody("application/x-www-form-urlencoded".toMediaType())
            try {
                val request = Request.Builder()
                    .url("${Settings.llmUrl}/chat")
                    .post(body)
                    .addHeader("Authorization", "Bearer ${Auth.token}")
                    .build()
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
                        
                        
                        if (json.has("message")) {
                            val msgObj = json.getJSONObject("message")
                            val role = msgObj.optString("role", "assistant")
                            var content = msgObj.optString("content")
                            val created = msgObj.optString("created_at", null)
                            val toolCallsArray = msgObj.optJSONArray("tool_calls")
                            val messageId = msgObj.optInt("message_id", -1)
                            
                            if (messageId == -1) {
                                Log.e(TAG, "Message missing message_id: $msgObj")
                                channel.close(Exception("Message missing required message_id"))
                                _typing.postValue(false)
                                return@use
                            }
                            
                            // For tool messages, send directly without modification
                            if (role == "tool") {
                                val msg = ChatMessage(content, role, created, false, messageId)
                                channel.trySend(msg)
                            } else {
                                // Parse and append tool calls to content for assistant messages
                                if (toolCallsArray != null && toolCallsArray.length() > 0) {
                                    val toolCallsText = StringBuilder()
                                    for (i in 0 until toolCallsArray.length()) {
                                        val toolCall = toolCallsArray.getJSONObject(i)
                                        val function = toolCall.getJSONObject("function")
                                        val name = function.optString("name")
                                        val arguments = function.optString("arguments")
                                        toolCallsText.append("\n```tool\n$name($arguments)\n```")
                                    }
                                    content += toolCallsText.toString()
                                }
                                
                                val msg = ChatMessage(content, role, created, false, messageId)
                                channel.trySend(msg)
                            }
                            
                            if (role == "assistant" && content.isNotEmpty()) {
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
                            }
                        }
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

    private fun startHealthCheck() {
        healthCheckJob?.cancel()
        healthCheckJob = scope.launch {
            while (true) {
                try {
                    val request = Request.Builder()
                        .url("${Settings.llmUrl}/health")
                        .addHeader("Authorization", "Bearer ${Auth.token}")
                        .build()
                    client.newCall(request).execute().use { resp ->
                        _connected.postValue(resp.isSuccessful)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Health check failed", e)
                    _connected.postValue(false)
                }
                delay(5000) // Check every 5 seconds
            }
        }
    }

    fun destroy() {
        healthCheckJob?.cancel()
        speakingJob?.cancel()
    }
}
