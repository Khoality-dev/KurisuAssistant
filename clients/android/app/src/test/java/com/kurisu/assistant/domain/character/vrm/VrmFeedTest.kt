package com.kurisu.assistant.domain.character.vrm

import androidx.webkit.WebViewFeature
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.EmotionCue
import com.kurisu.assistant.data.model.Message
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VrmFeedTest {

    private fun typeOf(message: String) = Regex("\"t\":\"([a-z-]+)\"").find(message)!!.groupValues[1]

    @Test
    fun `a page that becomes ready is caught up on what holds, in order, then follows live`() = runTest {
        val feed = VrmFeed()
        feed.send(BridgeMessages.config(buildJsonObject { put("kind", "vrm") }, "Kurisu"))
        feed.send(BridgeMessages.feed(isThinking = true))
        feed.send(BridgeMessages.gestures(listOf("wave"), seq = 1))
        feed.send(BridgeMessages.subtitle("Hi.", isUser = false, durationMs = null))
        feed.send(BridgeMessages.resting("sad")!!)
        feed.send(BridgeMessages.feed(isThinking = false))

        val received = mutableListOf<String>()
        val job = launch(UnconfinedTestDispatcher(testScheduler)) { feed.follow().collect { received += it } }
        // Config first, so the page has a character before anything moves it; a
        // gesture or a subtitle that has passed is not replayed, and only the
        // latest of each kept message is.
        assertThat(received.map(::typeOf)).containsExactly("config", "resting", "feed").inOrder()
        assertThat(received.last()).contains("\"isThinking\":false")

        feed.send(BridgeMessages.gestures(listOf("open_palm"), seq = 2))
        assertThat(received.map(::typeOf).last()).isEqualTo("gestures")
        job.cancel()
    }

    @Test
    fun `the sentence being spoken is replayed and dropped once speech ends`() = runTest {
        val feed = VrmFeed()
        feed.send(BridgeMessages.speech(com.kurisu.assistant.domain.tts.SpeechSegment("Hi.", 1, 500, 33.3, null, emptyList())))
        feed.send(BridgeMessages.speechSync(com.kurisu.assistant.domain.tts.SpeechSync(100, 101)))
        assertThat(feed.replay().map(::typeOf)).containsExactly("speech")

        feed.send(BridgeMessages.speech(null))
        assertThat(feed.replay()).isEmpty()
    }

    @Test
    fun `a page is handed a message port only when every call it needs is there`() {
        val all = setOf(
            WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL,
            WebViewFeature.POST_WEB_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE,
        )
        assertThat(chooseTransport { it in all }).isEqualTo(BridgeTransport.MESSAGE_PORT)
        // An older WebView can create a channel and still throw when posting on it.
        for (missing in all) {
            assertThat(chooseTransport { it in all - missing }).isEqualTo(BridgeTransport.EVALUATE_JAVASCRIPT)
        }
    }

    @Test
    fun `evaluateJavascript is handed the message as a script that cannot be broken out of`() {
        val script = pushScript("{\"t\":\"subtitle\",\"text\":\"a b</script>\",\"isUser\":false,\"durationMs\":null}")
        assertThat(script).startsWith("window.__kurisu && window.__kurisu.push(")
        assertThat(script).doesNotContain(" ")
        assertThat(script).contains("\\u2028")
    }

    @Test
    fun `a reopened conversation rests on the last feeling of its last reply, for that persona only`() {
        val messages = listOf(
            Message(role = "assistant", content = "a", personaId = 1, emotionCues = listOf(EmotionCue("happy", 0))),
            Message(role = "user", content = "b"),
            Message(role = "assistant", content = "c", personaId = 1, emotionCues = listOf(EmotionCue("sad", 0), EmotionCue("relaxed", 4))),
            Message(role = "user", content = "d"),
        )
        assertThat(restingEmotionOf(messages, personaId = 1)).isEqualTo("relaxed")
        assertThat(restingEmotionOf(messages, personaId = 2)).isNull()
        // The last reply had no feeling: the face rests on its default, not on an older one.
        val plain = messages + Message(role = "assistant", content = "e", personaId = 1)
        assertThat(restingEmotionOf(plain, personaId = 1)).isNull()
        assertThat(restingEmotionOf(emptyList(), personaId = 1)).isNull()
    }
}
