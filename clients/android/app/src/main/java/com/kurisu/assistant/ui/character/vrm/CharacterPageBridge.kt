package com.kurisu.assistant.ui.character.vrm

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.kurisu.assistant.domain.character.vrm.BridgeTransport
import com.kurisu.assistant.domain.character.vrm.VrmFeed
import com.kurisu.assistant.domain.character.vrm.chooseTransport
import com.kurisu.assistant.domain.character.vrm.pushScript
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The 3D character page in a [WebView], and the one channel into it (#246).
 *
 * The page is the desktop's renderer as a committed single file
 * (`assets/character/index.html`, #245), served from a real https origin by
 * `WebViewAssetLoader`. Its model and clips come from the same origin, answered
 * by [AuthedCharacterAssetHandler], so the token stays in Kotlin. Nothing else
 * loads: every navigation is refused and every other request answered 403.
 *
 * When the page says it is ready it gets the [feed]'s replay, then every
 * message as it happens — over a `WebMessagePort` when this WebView can do all
 * of it, otherwise through `evaluateJavascript`. A page that reloads says ready
 * again and is caught up again.
 */
class CharacterPageBridge(
    private val webView: WebView,
    private val feed: VrmFeed,
    private val scope: CoroutineScope,
    private val onProblem: (String) -> Unit,
) {
    private var following: Job? = null
    private var port: WebMessagePortCompat? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun load(assetHandler: AuthedCharacterAssetHandler) {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(webView.context))
            .addPathHandler("/character-assets/", assetHandler)
            .build()

        webView.setBackgroundColor(Color.BLACK)
        webView.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (url.scheme != "https" || url.host != Uri.parse(CHARACTER_PAGE_ORIGIN).host) return forbidden()
                if (!isAllowedPagePath(url.path.orEmpty())) return forbidden()
                return loader.shouldInterceptRequest(url) ?: forbidden()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Returning true keeps the app alive; the WebView is unusable from here.
                Log.w(TAG, "character page renderer gone (crashed=${detail.didCrash()})")
                stopFollowing()
                onProblem("The 3D character stopped. Open it again to reload it.")
                return true
            }
        }
        webView.addJavascriptInterface(NativeCallbacks(), NATIVE_NAME)
        webView.loadUrl(CHARACTER_PAGE_URL)
    }

    fun close() {
        stopFollowing()
        webView.removeJavascriptInterface(NATIVE_NAME)
    }

    private fun startFollowing() {
        stopFollowing()
        val send: (String) -> Unit = when (chooseTransport { WebViewFeature.isFeatureSupported(it) }) {
            BridgeTransport.MESSAGE_PORT -> {
                val (mine, theirs) = WebViewCompat.createWebMessageChannel(webView)
                WebViewCompat.postWebMessage(webView, WebMessageCompat("kurisu:port", arrayOf(theirs)), Uri.parse(CHARACTER_PAGE_ORIGIN))
                port = mine
                ({ message -> mine.postMessage(WebMessageCompat(message)) })
            }
            BridgeTransport.EVALUATE_JAVASCRIPT -> ({ message -> webView.evaluateJavascript(pushScript(message), null) })
        }
        following = scope.launch(Dispatchers.Main.immediate) { feed.follow().collect(send) }
    }

    private fun stopFollowing() {
        following?.cancel()
        following = null
        port?.close()
        port = null
    }

    /** `window.KurisuNative`: the page's three callbacks, called on the WebView's JS thread. */
    private inner class NativeCallbacks {
        @JavascriptInterface
        fun ready() {
            webView.post { startFollowing() }
        }

        @JavascriptInterface
        fun firstFrame() = Unit

        @JavascriptInterface
        fun error(code: String, message: String) {
            // The page shows its own sentence for each (no WebGL, a failed load);
            // the log is for whoever is debugging a phone.
            Log.w(TAG, "character page: $code — $message")
        }
    }

    private companion object {
        const val TAG = "CharacterPage"
        const val NATIVE_NAME = "KurisuNative"
    }
}
