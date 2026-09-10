package com.kurisu.assistant.domain.tts

import com.google.common.truth.Truth.assertThat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/** The one line the user sees when a speech request fails (#200). */
class SpeechFailureTest {

    private fun http(code: Int, body: String): HttpException =
        HttpException(Response.error<Any>(code, body.toResponseBody("application/json".toMediaType())))

    @Test
    fun `uses the API detail when there is one`() {
        val e = http(502, """{"detail":"The speech service is unavailable."}""")
        assertThat(describeSpeechFailure("Speech", e))
            .isEqualTo("Speech failed: The speech service is unavailable.")
    }

    @Test
    fun `falls back to the status when the body says nothing useful`() {
        assertThat(describeSpeechFailure("Transcription", http(500, "not json")))
            .isEqualTo("Transcription failed: the server answered 500.")
        assertThat(describeSpeechFailure("Transcription", http(404, """{"detail":""}""")))
            .isEqualTo("Transcription failed: the server answered 404.")
    }

    @Test
    fun `an unreachable server reads as unreachable`() {
        assertThat(describeSpeechFailure("Speech", IOException("Failed to connect to /10.0.0.2:15597")))
            .isEqualTo("Speech failed: the server could not be reached.")
    }

    @Test
    fun `anything else keeps its message or says something`() {
        assertThat(describeSpeechFailure("Speech", IllegalStateException("MediaPlayer in wrong state")))
            .isEqualTo("Speech failed: MediaPlayer in wrong state.")
        assertThat(describeSpeechFailure("Speech", RuntimeException()))
            .isEqualTo("Speech failed: something went wrong.")
    }
}
