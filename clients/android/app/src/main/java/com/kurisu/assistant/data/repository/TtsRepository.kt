package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.TTSRequest
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TtsRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /** Synthesize speech, returns WAV bytes */
    suspend fun synthesize(
        text: String,
        voice: String? = null,
        language: String? = null,
        backend: String? = null,
        emoAudio: String? = null,
        emoAlpha: Float? = null,
        useEmoText: Boolean? = null,
    ): ByteArray {
        val request = TTSRequest(
            text = text,
            voice = voice,
            language = language,
            provider = backend,
            emoAudio = emoAudio,
            emoAlpha = emoAlpha,
            useEmoText = useEmoText,
        )
        val responseBody = api.synthesize(request)
        return responseBody.bytes()
    }

    suspend fun listVoices(backend: String? = null): List<String> =
        api.listVoices(backend).voices

    suspend fun listBackends(): List<String> =
        api.listBackends().backends
}
