package com.kurisuassistant.android

import android.media.AudioTrack
import android.util.Log
import androidx.collection.MutableIntList
import com.kurisuassistant.android.utils.Util
import kotlinx.coroutines.yield
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class Agent(val player: AudioTrack) {
    private val modelName = "qwen2.5:3b"
    private val TAG = "Agent"
    private var client: OkHttpClient
    private var webSocket: WebSocket

    init {
        client = OkHttpClient()
        val request = Request.Builder()
            .url(BuildConfig.WS_API_URL)  // use your actual URL
            .build()

        // 4. Define WebSocketListener to receive ByteString PCM frames
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                super.onOpen(webSocket, response)
                Log.d(TAG, "WebSocket opened: ${response.request.url}")
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                super.onMessage(webSocket, bytes)
                // 5. Write raw PCM into AudioTrack
                val pcmChunk = bytes.toByteArray()
                player.write(pcmChunk, 0, pcmChunk.size)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                super.onMessage(webSocket, text)
                    Log.d(TAG, text)
//                val jsonObject = JSONObject(text);
//                Log.d(TAG, jsonObject.toString())
//                if (jsonObject.has("text"))
//                {
//                    Log.d(TAG, jsonObject.get("text").toString())
//                }
//                else
//                {
//                    Log.d(TAG, jsonObject.get("text").toString())
//                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                super.onClosing(webSocket, code, reason)
                Log.d(TAG, "WebSocket closing: $code / $reason")
                player.stop()
                player.release()
                webSocket.close(1000, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                super.onFailure(webSocket, t, response)
                Log.e(TAG, "WebSocket failure: ${t.localizedMessage}", t)
                player.stop()
                player.release()
            }
        }

        // 6. Open WebSocket
        webSocket = client.newWebSocket(request, listener)
    }

//
//    fun stt(audioBuffer: MutableIntList): String {
//        // 1) Prepare JSON request body
//        val mediaType = "application/octet-stream".toMediaType()
//        val data = Util.toByteArray(audioBuffer)
//        // 3. Wrap your byte array in a RequestBody
//        val body = data.toRequestBody(mediaType)
//
//        // 4. Build the POST request
//        val request = Request.Builder()
//            .url(ASRAPIURL)
//            .header("Authorization", token)
//            .post(body)
//            .build()
//
//        var text : String
//        // 5. Execute synchronously (must be on a background thread)
//        httpClient.newCall(request).execute().use { response ->
//            if (!response.isSuccessful) {
//                throw IOException("Unexpected HTTP code ${response.code}")
//            }
//            // 6. Return the response body as a String
//            text = JSONObject(response.body?.string().orEmpty()).get("text").toString()
//        }
//        return text
//    }
//
//    fun tts(text: String): ShortArray? {
//        val mediaType = "application/json; charset=utf-8".toMediaType()
//        val json = """{"text": ${JSONObject.quote(text)}}"""
//        // 3. Wrap your byte array in a RequestBody
//        val body = json.toRequestBody(mediaType)
//
//
//
//        // 4. Build the POST request
//        val request = Request.Builder()
//            .url(TTSAPIURL)
//            .header("Authorization", token)
//            .post(body)
//            .build()
//
//        // 5. Execute synchronously (must be on a background thread)
//        httpClient.newCall(request).execute().use { response ->
//            if (!response.isSuccessful) {
//                throw IOException("Unexpected HTTP code ${response.code}")
//            }
//            // 6. Return the response body as a String
//            val byteArray = response.body!!.bytes()
//            val shortArray = Util.toShortArray(byteArray)
//            return shortArray
//        }
//
//        return null
//    }

//    fun chat(text: String): Sequence<String> = sequence {
//        // 4. Build the POST request
//        val request = Request.Builder()
//            .url(LLMAPIURL)
//            .header("Authorization", token)
//            .post(body)
//            .build()
//
//
//    }

}
