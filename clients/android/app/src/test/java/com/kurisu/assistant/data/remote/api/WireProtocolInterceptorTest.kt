package com.kurisu.assistant.data.remote.api

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.ServerVersionInfo
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test

/**
 * A 426 from a live server must reach the update gate with the server's
 * numbers (#150), and must not be mistaken for anything else.
 */
class WireProtocolInterceptorTest {

    private val backendBody =
        """{"detail":"wire_protocol_mismatch","client_wire_protocol":5,"server_wire_protocol":6,"backend_version":"0.9.0"}"""

    @Test
    fun `parses the backend's 426 body into the server's version`() {
        assertThat(WireProtocolInterceptor.parse426Body(backendBody))
            .isEqualTo(ServerVersionInfo(backendVersion = "0.9.0", wireProtocol = 6))
    }

    @Test
    fun `a body without the server's number is not a version`() {
        assertThat(WireProtocolInterceptor.parse426Body("")).isNull()
        assertThat(WireProtocolInterceptor.parse426Body(null)).isNull()
        assertThat(WireProtocolInterceptor.parse426Body("<html>Upgrade Required</html>")).isNull()
        assertThat(WireProtocolInterceptor.parse426Body("""{"detail":"nope"}""")).isNull()
    }

    @Test
    fun `a 426 response raises the signal and stays readable downstream`() {
        val signal = ProtocolMismatchSignal()
        val response = intercept(signal, code = 426, body = backendBody)

        assertThat(signal.mismatch.value)
            .isEqualTo(ServerVersionInfo(backendVersion = "0.9.0", wireProtocol = 6))
        assertThat(response.body!!.string()).isEqualTo(backendBody)
    }

    @Test
    fun `a 426 with an unreadable body still raises the signal, with the server unknown`() {
        val signal = ProtocolMismatchSignal()
        intercept(signal, code = 426, body = "Upgrade Required")

        assertThat(signal.mismatch.value).isEqualTo(ProtocolMismatchSignal.unknown)
        assertThat(signal.mismatch.value!!.wireProtocol).isLessThan(0)
    }

    @Test
    fun `any other status leaves the signal alone and stamps the header`() {
        val signal = ProtocolMismatchSignal()
        val sent = slot<Request>()
        intercept(signal, code = 200, body = "{}", sent = sent)

        assertThat(signal.mismatch.value).isNull()
        assertThat(sent.captured.header("X-Wire-Protocol"))
            .isEqualTo(BuildConfig.WIRE_PROTOCOL.toString())
    }

    private fun intercept(
        signal: ProtocolMismatchSignal,
        code: Int,
        body: String,
        sent: io.mockk.CapturingSlot<Request> = slot(),
    ): Response {
        val request = Request.Builder().url("http://placeholder/models").build()
        val chain = mockk<Interceptor.Chain>()
        every { chain.request() } returns request
        every { chain.proceed(capture(sent)) } answers {
            Response.Builder()
                .request(sent.captured)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message(if (code == 426) "Upgrade Required" else "OK")
                .body(body.toResponseBody("application/json".toMediaType()))
                .build()
        }
        return WireProtocolInterceptor(signal).intercept(chain)
    }
}
