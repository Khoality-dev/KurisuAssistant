package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.remote.api.KurisuApiService
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

data class TranscriptionResult(val text: String, val language: String)

@Singleton
class AsrRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /** Send raw PCM bytes to the ASR endpoint and get transcription text + detected language */
    suspend fun transcribe(
        audioBytes: ByteArray,
        language: String? = null,
        mode: String? = null,
    ): TranscriptionResult {
        val body = audioBytes.toRequestBody("application/octet-stream".toMediaTypeOrNull())
        val lang = language?.ifBlank { null }
        val m = mode?.ifBlank { null }
        val response = api.transcribe(body, lang, m)
        return TranscriptionResult(text = response.text, language = response.language)
    }
}
