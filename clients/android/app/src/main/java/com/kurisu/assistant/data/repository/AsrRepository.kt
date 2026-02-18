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
    /** Send raw PCM bytes to the ASR endpoint and get transcription text */
    suspend fun transcribe(audioBytes: ByteArray, language: String? = null): String {
        val body = audioBytes.toRequestBody("application/octet-stream".toMediaTypeOrNull())
        val lang = language?.ifBlank { null }
        val response = api.transcribe(body, lang)
        return response.text
    }
}
