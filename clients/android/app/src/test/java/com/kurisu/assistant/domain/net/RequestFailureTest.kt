package com.kurisu.assistant.domain.net

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import javax.net.ssl.SSLHandshakeException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * The sentence shown when a request fails for a reason the API did not write
 * (#263); the desktop's `requestFailure.test.ts` pins the same sentences.
 */
class RequestFailureTest {

    private fun http(status: Int, body: String = "<html>nginx</html>", type: String = "text/html"): HttpException =
        HttpException(Response.error<Any>(status, body.toResponseBody(type.toMediaType())))

    @Test
    fun `names a proxy's 403 as something in front of the server`() {
        assertEquals(
            "Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network.",
            RequestFailure.describe(http(403), "https://kurisu.example:15597"),
        )
    }

    @Test
    fun `says the credentials were refused on a 401 and that no server answers on a 404`() {
        assertEquals("The server refused the credentials.", RequestFailure.describe(http(401), null))
        assertEquals("No KurisuAssistant server answers at this address (HTTP 404).", RequestFailure.describe(http(404), null))
    }

    @Test
    fun `blames the proxy on 502 503 504 and the server on another 5xx`() {
        for (status in listOf(502, 503, 504)) {
            assertEquals("The server is not reachable behind its proxy (HTTP $status).", RequestFailure.describe(http(status), null))
        }
        assertEquals("The server failed (HTTP 500).", RequestFailure.describe(http(500), null))
    }

    @Test
    fun `names the code for any other status`() {
        assertEquals("The server answered HTTP 422.", RequestFailure.describe(http(422), null))
    }

    @Test
    fun `names the origin when nothing answered`() {
        assertEquals(
            "Nothing answered at https://kurisu.example:15597. Check the address and that the server is running.",
            RequestFailure.describe(ConnectException("Connection refused"), "https://kurisu.example:15597"),
        )
        assertEquals(
            "Nothing answered at the server address. Check the address and that the server is running.",
            RequestFailure.describe(UnknownHostException("kurisu.example"), null),
        )
    }

    @Test
    fun `recognises a certificate failure wherever it sits in the cause chain`() {
        val expected = "The server's certificate is not trusted by this app."
        assertEquals(expected, RequestFailure.describe(SSLHandshakeException("PKIX path building failed"), null))
        assertEquals(expected, RequestFailure.describe(RuntimeException("wrapped", CertPathValidatorException("self-signed")), null))
    }

    @Test
    fun `says the server did not answer in time on a timeout`() {
        assertEquals("The server did not answer in time.", RequestFailure.describe(SocketTimeoutException("timeout"), null))
    }

    @Test
    fun `leaves the app's own exceptions alone`() {
        assertNull(RequestFailure.describe(IllegalStateException("QR code is not a Kurisu login code"), null))
    }
}
