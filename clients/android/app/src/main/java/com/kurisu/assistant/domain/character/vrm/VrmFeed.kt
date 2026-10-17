package com.kurisu.assistant.domain.character.vrm

import androidx.webkit.WebViewFeature
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.onSubscription
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * What the character page is told, kept so a page that loads late is caught up
 * (#246). The page keeps the latest of each message as its feed; this keeps
 * the same latest for the kinds that describe a state — the character, the
 * face at rest, the sentence being spoken, thinking, the faces in view — and
 * none of the kinds that are moments: a gesture burst, a subtitle, a sync.
 * The desktop's character window does the same on its `character:ready`.
 */
class VrmFeed {
    private val latest = LinkedHashMap<String, String>()
    private val live = MutableSharedFlow<String>(extraBufferCapacity = 64)

    @Synchronized
    fun send(message: JsonObject) {
        val type = message.getValue("t").jsonPrimitive.content
        val text = message.toString()
        when {
            type == "speech" && message["segment"] is JsonNull -> latest.remove(type)
            type in REPLAYED -> latest[type] = text
        }
        live.tryEmit(text)
    }

    /** What holds now, in the order the page needs it: the character first. */
    @Synchronized
    fun replay(): List<String> = REPLAYED.mapNotNull { latest[it] }

    /** The replay, then every message from now on, with nothing lost between. */
    fun follow(): Flow<String> = live.onSubscription { replay().forEach { emit(it) } }

    private companion object {
        val REPLAYED = listOf("config", "resting", "speech", "feed", "faces")
    }
}

/** How Kotlin reaches the page. */
enum class BridgeTransport { MESSAGE_PORT, EVALUATE_JAVASCRIPT }

/**
 * A `WebMessagePort` only when every call it needs exists: creating the
 * channel, handing a port to the page, and posting on it are separate features,
 * and an older WebView can do the first and throw on the others.
 */
fun chooseTransport(isSupported: (String) -> Boolean): BridgeTransport =
    if (
        isSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) &&
        isSupported(WebViewFeature.POST_WEB_MESSAGE) &&
        isSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE)
    ) BridgeTransport.MESSAGE_PORT else BridgeTransport.EVALUATE_JAVASCRIPT

/**
 * The script `evaluateJavascript` runs for one message. JSON is a JavaScript
 * expression except for two line terminators older engines reject inside a
 * string, so those are escaped; nothing in it can end the call early.
 */
fun pushScript(json: String): String {
    val safe = json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return "window.__kurisu && window.__kurisu.push($safe)"
}
