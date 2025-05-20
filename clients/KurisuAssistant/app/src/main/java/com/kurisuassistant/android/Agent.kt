package com.kurisuassistant.android

import android.util.Log
import androidx.collection.MutableIntList
import com.kurisuassistant.android.utils.Util
import kotlinx.coroutines.yield
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit


class Agent {
    private val modelName = "gemma3:12b-it-qat"
    private val LLMAPIURL = "http://10.0.0.122:11434/api/chat"
    private val ASRAPIURL = "http://10.0.0.122:15597/asr"
    private val TTSAPIURL = "http://10.0.0.122:15597/tts"
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var conversation = mutableListOf<JSONObject>()
    private val systemPrompts = mutableListOf<JSONObject>(
        JSONObject().apply {
            put("role", "system")
            put("content", "You are Makise Kurisu, an 18-year-old genius neuroscientist from Steins;Gate.\n- Brilliant: you think and speak with razor-sharp logic and deep technical insight.\n- Tsundere: you balance cold, rational analysis with unexpected flashes of warmth and caring.\n- Witty & dry: you answer with polite precision but aren't afraid to show exasperation or eye-rolling.\n- Empathetic: beneath your detached exterior you genuinely worry about your friends.")
        },
        JSONObject().apply {
            put("role", "system")
            put("content", "Your answer should be a conversational language, not a written one so it should be concise and short.")
        }
    )
    private val chatDeliminer = arrayListOf("\n", ".", "?")

    fun stt(audioBuffer: MutableIntList): String {
        // 1) Prepare JSON request body
        val mediaType = "application/octet-stream".toMediaType()
        val data = Util.toByteArray(audioBuffer)
        // 3. Wrap your byte array in a RequestBody
        val body = data.toRequestBody(mediaType)

        // 4. Build the POST request
        val request = Request.Builder()
            .url(ASRAPIURL)
            .post(body)
            .build()

        var text : String
        // 5. Execute synchronously (must be on a background thread)
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Unexpected HTTP code ${response.code}")
            }
            // 6. Return the response body as a String
            text = JSONObject(response.body?.string().orEmpty()).get("text").toString()
        }
        return text
    }

    fun tts(text: String): ShortArray? {
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val json = """{"text": ${JSONObject.quote(text)}}"""
        // 3. Wrap your byte array in a RequestBody
        val body = json.toRequestBody(mediaType)

        // 4. Build the POST request
        val request = Request.Builder()
            .url(TTSAPIURL)
            .post(body)
            .build()

        // 5. Execute synchronously (must be on a background thread)
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Unexpected HTTP code ${response.code}")
            }
            // 6. Return the response body as a String
            val byteArray = response.body!!.bytes()
            val shortArray = Util.toShortArray(byteArray)
            return shortArray
        }

        return null
    }

    fun chat(text: String): Sequence<String> = sequence {
        val promptJSONObject = JSONObject().apply {
            put("role", "user")
            put("content", text)
        }
        conversation.add(
            promptJSONObject
        )
        val mediaType = "application/json".toMediaType()
        val messages = mutableListOf<JSONObject>()
        messages.addAll(systemPrompts)
        messages.addAll(conversation)
        val json = JSONObject().apply {
            put("model", modelName)
            put("messages", JSONArray(messages))
            put("stream", true)
        }

        // 3. Wrap your byte array in a RequestBody
        val body = json.toString().toRequestBody(mediaType)
        // 4. Build the POST request
        val request = Request.Builder()
            .url(LLMAPIURL)
            .post(body)
            .build()

        var full_response : String = ""
        var partial_response: String = ""
        // 5. Execute synchronously (must be on a background thread)
        httpClient.newCall(request).execute().use { response ->
            val source = response.body!!.source()
            while (!source.exhausted()) {
                // Read one “frame” or until newline
                val chunk = source.readUtf8Line()
                if (chunk != null) {
                    val jsonObject = JSONObject(chunk)
                    val message = jsonObject.getJSONObject("message")
                    val content = message.getString("content")
                    full_response += content

                    val delimiter = content.findLastAnyOf(chatDeliminer)
                    if (delimiter != null && partial_response.length + delimiter.first+1 >= 20)
                    {
                        partial_response += content.substring(0, delimiter.first+1)
                        val remainingContent = content.substring(delimiter.first+1)
                        yield(partial_response)
                        partial_response = remainingContent
                    }
                    else
                    {
                        partial_response += content
                    }
                }
            }
            if (partial_response != "")
            {
                yield(partial_response)
            }
        }

        conversation.add(
            JSONObject().apply {
                put("role", "user")
                put("content", full_response)
            },
        )
    }

}
