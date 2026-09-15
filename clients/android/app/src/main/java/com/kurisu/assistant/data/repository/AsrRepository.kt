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
    /**
     * Send raw PCM bytes to the ASR endpoint and get transcription text + detected
     * language. [model] is a universal-voice model id; null leaves the choice to
     * the server.
     */
    suspend fun transcribe(
        audioBytes: ByteArray,
        language: String? = null,
        model: String? = null,
    ): TranscriptionResult {
        val body = audioBytes.toRequestBody("application/octet-stream".toMediaTypeOrNull())
        val response = api.transcribe(body, language?.ifBlank { null }, model?.ifBlank { null })
        return TranscriptionResult(text = response.text, language = response.language)
    }

    /** Ask the server which language a clip is in, without transcribing it. */
    suspend fun detectLanguage(audioBytes: ByteArray, model: String? = null): String {
        val body = audioBytes.toRequestBody("application/octet-stream".toMediaTypeOrNull())
        return api.detectLanguage(body, model?.ifBlank { null }).language
    }
}
