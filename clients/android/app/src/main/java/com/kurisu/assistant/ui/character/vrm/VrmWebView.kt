package com.kurisu.assistant.ui.character.vrm

import android.util.Log
import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.kurisu.assistant.domain.character.vrm.VrmFeed

/**
 * A VRM persona's character: the character page in a WebView (#246).
 *
 * The WebView belongs to this composition, not to the ViewModel — the
 * ViewModel outlives every dismissal of the sheet and every rotation, and a
 * View held there would keep the Activity alive. It is made in `remember`,
 * paused and resumed with the lifecycle, and destroyed when the sheet goes: an
 * undestroyed WebView keeps its renderer process. A phone with no usable
 * WebView gets [onProblem] instead of a crash.
 */
@Composable
fun VrmWebView(
    feed: VrmFeed,
    assetHandler: AuthedCharacterAssetHandler,
    onProblem: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val webView = remember {
        try {
            WebView(context)
        } catch (e: Exception) {
            // No WebView provider installed or enabled.
            Log.w("VrmWebView", "no WebView: ${e.message}")
            null
        }
    }
    if (webView == null) {
        LaunchedEffect(Unit) { onProblem("This phone has no WebView to show a 3D character with.") }
        return
    }
    val bridge = remember(webView) { CharacterPageBridge(webView, feed, scope, onProblem) }

    DisposableEffect(webView, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> webView.onPause()
                Lifecycle.Event.ON_RESUME -> webView.onResume()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            bridge.close()
            webView.destroy()
        }
    }

    AndroidView(
        factory = {
            bridge.load(assetHandler)
            webView
        },
        modifier = modifier.testTag("vrm-character"),
    )
}
