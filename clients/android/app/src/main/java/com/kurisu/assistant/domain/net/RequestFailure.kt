package com.kurisu.assistant.domain.net

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import retrofit2.HttpException

/**
 * One sentence a person can act on, for a request that failed for a reason the
 * API did not write (#263).
 *
 * The API's own `detail` is read by `apiErrorMessage` before this is asked;
 * what reaches here is everything else — a proxy in front of the server
 * refusing this network with its own HTML page, nothing listening at the
 * address, a certificate the app does not trust, a timeout. Retrofit and the
 * JDK describe those as "HTTP 403 Forbidden" or "Connection refused", which
 * names nothing a person can check. The desktop's `requestFailure.ts` says the
 * same sentences.
 */
object RequestFailure {

    /** The sentence for a status the API gave no detail for, or null when the code is not one we name. */
    fun describeStatus(status: Int): String? = when (status) {
        401 -> "The server refused the credentials."
        403 -> "Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network."
        404 -> "No KurisuAssistant server answers at this address (HTTP 404)."
        502, 503, 504 -> "The server is not reachable behind its proxy (HTTP $status)."
        else -> when {
            status >= 500 -> "The server failed (HTTP $status)."
            status > 0 -> "The server answered HTTP $status."
            else -> null
        }
    }

    /**
     * The sentence for a transport failure, or null when `t` is not one — an
     * `HttpException` (the API answered) or an exception of the app's own.
     * `origin` is the server address the user typed, named so they know what
     * to check.
     */
    fun describe(t: Throwable, origin: String?): String? {
        if (t is HttpException) return describeStatus(t.code())
        if (isCertificateFailure(t)) return "The server's certificate is not trusted by this app."
        if (t is SocketTimeoutException) return "The server did not answer in time."
        if (t is ConnectException || t is UnknownHostException) {
            val where = origin?.takeIf { it.isNotBlank() } ?: "the server address"
            return "Nothing answered at $where. Check the address and that the server is running."
        }
        return null
    }

    private fun isCertificateFailure(t: Throwable): Boolean {
        var cause: Throwable? = t
        var hops = 0
        while (cause != null && hops < 8) {
            if (cause is SSLHandshakeException || cause is SSLPeerUnverifiedException ||
                cause is CertPathValidatorException || cause is CertificateException
            ) return true
            cause = cause.cause
            hops++
        }
        return false
    }
}
