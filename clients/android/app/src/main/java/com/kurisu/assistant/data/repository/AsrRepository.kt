package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.remote.api.KurisuApiService
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AsrRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /** Send raw audio bytes (WAV or PCM) to the ASR endpoint and get transcription text */
    suspend fun transcribe(audioBytes: ByteArray): String {
        val body = audioBytes.toRequestBody("application/octet-stream".toMediaTypeOrNull())
        val response = api.transcribe(body)
        return response.text
    }
}
