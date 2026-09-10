package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.TTSRequest
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TtsRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    /**
     * Synthesize speech, returns WAV bytes. A blank [backend] is not sent, so the
     * server's default TTS model answers — the client does not guess one (#200).
     */
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
            voice = voice?.ifBlank { null },
            language = language?.ifBlank { null },
            provider = backend?.ifBlank { null },
            emoAudio = emoAudio,
            emoAlpha = emoAlpha,
            useEmoText = useEmoText,
        )
        val responseBody = api.synthesize(request)
        return responseBody.bytes()
    }

    suspend fun listVoices(backend: String? = null): List<String> =
        api.listVoices(backend?.ifBlank { null }).voices

    /** The TTS model ids the speech service serves, from `GET /tts/models`. */
    suspend fun listBackends(): List<String> =
        api.listTtsModels().models.map { it.id }
}
