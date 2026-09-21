package com.kurisu.assistant.ui.assistant

import java.net.ConnectException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/** What a person reads when a call fails: the API's own detail first, then a sentence per kind of failure (#263). */
class ApiErrorTest {

    private fun http(status: Int, body: String, type: String): HttpException =
        HttpException(Response.error<Any>(status, body.toResponseBody(type.toMediaType())))

    @Test
    fun `the API's detail wins whatever the status`() {
        val e = http(403, """{"detail":"This account is not activated yet."}""", "application/json")
        assertEquals("This account is not activated yet.", apiErrorMessage(e, "Authentication failed"))
    }

    @Test
    fun `a proxy's HTML 403 is named, not shown as HTTP 403 Forbidden`() {
        val e = http(403, "<html><h1>403 Forbidden</h1></html>", "text/html")
        assertEquals(
            "Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network.",
            apiErrorMessage(e, "Authentication failed"),
        )
    }

    @Test
    fun `nothing answering names the origin the login screen passed`() {
        assertEquals(
            "Nothing answered at http://10.0.0.5:15597. Check the address and that the server is running.",
            apiErrorMessage(ConnectException("Connection refused"), "Authentication failed", origin = "http://10.0.0.5:15597"),
        )
    }

    @Test
    fun `the app's own exceptions keep their message, and a silent one gets the fallback`() {
        assertEquals("QR code is missing fields", apiErrorMessage(IllegalStateException("QR code is missing fields"), "Could not sign in"))
        assertEquals("Could not sign in", apiErrorMessage(IllegalStateException(), "Could not sign in"))
    }
}
