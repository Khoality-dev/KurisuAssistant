package com.kurisu.assistant.ui.character.vrm

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import com.kurisu.assistant.domain.character.vrm.CharacterAssetResolver
import java.io.ByteArrayInputStream

/** The origin the character page is served from: a real https origin, never `file://`. */
const val CHARACTER_PAGE_ORIGIN = "https://appassets.androidplatform.net"
const val CHARACTER_PAGE_URL = "$CHARACTER_PAGE_ORIGIN/assets/character/index.html"

/**
 * `/character-assets/` on the page's origin, answered by [resolver] (#246).
 * The page fetches the config's URLs as they are; this hands it the model from
 * the device or the server, and the token stays in Kotlin.
 */
class AuthedCharacterAssetHandler(private val resolver: CharacterAssetResolver) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val served = resolver.handle(path)
        val body = served.file?.inputStream() ?: ByteArrayInputStream(ByteArray(0))
        return WebResourceResponse(
            served.mime,
            null,
            served.status,
            reasonFor(served.status),
            mapOf("Cache-Control" to "no-store"),
            body,
        )
    }
}

/**
 * The only paths the page's WebView may load: the page itself and its assets.
 * Everything else — the app's other assets, its resources, the network — is
 * refused with [forbidden].
 */
fun isAllowedPagePath(path: String): Boolean {
    if (".." in path) return false
    return path == "/assets/character/index.html" || path.startsWith("/character-assets/")
}

fun forbidden(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

private fun reasonFor(status: Int): String = when (status) {
    200 -> "OK"
    401 -> "Unauthorized"
    403 -> "Forbidden"
    404 -> "Not Found"
    502 -> "Bad Gateway"
    else -> if (status in 200..299) "OK" else "Error"
}
