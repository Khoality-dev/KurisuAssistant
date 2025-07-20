package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.Settings
import com.kurisuassistant.android.model.ChatMessage
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import okhttp3.MediaType.Companion.toMediaType
import com.kurisuassistant.android.utils.HttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONObject

/**
 * Agent communicating with the REST API instead of a WebSocket.
 */
class Agent(private val player: AudioTrack) {
    private val TAG = "Agent"
    private val scope = CoroutineScope(Dispatchers.IO)
    private var speakingJob: Job? = null

    private var chatChannel: Channel<ChatMessage>? = null
    private val _connected = MutableLiveData(true)
    val connected: LiveData<Boolean> get() = _connected
    private val _typing = MutableLiveData(false)
    val typing: LiveData<Boolean> get() = _typing
    private val _speaking = MutableLiveData(false)
    val speaking: LiveData<Boolean> get() = _speaking

    suspend fun stt(audioBuffer: MutableIntList): String {
        val data = Util.toByteArray(audioBuffer)
        val body = ByteString.of(*data).toByteArray().toRequestBody("application/octet-stream".toMediaType())
        try {
            HttpClient.post("${Settings.llmUrl}/asr", body, Auth.token).use { resp ->
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
            HttpClient.post("${Settings.ttsUrl}/tts", body).use { resp ->
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
        var receivedConversationId: Int? = null
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
                HttpClient.post("${Settings.llmUrl}/chat", body, Auth.token).use { resp ->
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
                        
                        // Check for conversation ID
                        if (json.has("conversation_id") && receivedConversationId == null) {
                            receivedConversationId = json.getInt("conversation_id")
                            Log.d(TAG, "Received conversation ID: $receivedConversationId")
                        }
                        
                        if (json.has("message")) {
                            val msgObj = json.getJSONObject("message")
                            val role = msgObj.optString("role", "assistant")
                            val content = msgObj.optString("content")
                            val created = msgObj.optString("created_at", null)
                            val toolCalls = msgObj.optJSONArray("tool_calls")?.toString()
                            val msg = ChatMessage(content, role, created, toolCalls)
                            channel.trySend(msg)
                            
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
                // Send conversation ID info if we got one
                receivedConversationId?.let { id ->
                    val idMsg = ChatMessage("", "system", null, null)
                    idMsg.conversationId = id
                    channel.trySend(idMsg)
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
