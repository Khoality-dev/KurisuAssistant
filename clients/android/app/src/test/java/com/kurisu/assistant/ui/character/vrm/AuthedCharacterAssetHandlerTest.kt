package com.kurisu.assistant.ui.character.vrm

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.domain.character.vrm.CharacterAssetFetcher
import com.kurisu.assistant.domain.character.vrm.CharacterAssetResolver
import com.kurisu.assistant.domain.character.vrm.VrmAssetRefs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.security.MessageDigest

/**
 * The thin half of the asset handler: a resolver's answer as the
 * `WebResourceResponse` the WebView reads. Robolectric, because under plain
 * JVM tests that class's getters all return null (#246).
 */
@RunWith(AndroidJUnit4::class)
class AuthedCharacterAssetHandlerTest {

    @get:Rule val tmp = TemporaryFolder()

    private val model = "model".toByteArray()
    private val sha = MessageDigest.getInstance("SHA-256").digest(model).joinToString("") { "%02x".format(it) }

    private fun handler(status: Int): AuthedCharacterAssetHandler {
        val resolver = CharacterAssetResolver(tmp.newFolder(), CharacterAssetFetcher { _, into ->
            if (status == 200) into.writeBytes(model)
            status
        })
        resolver.refs = VrmAssetRefs.of(
            1,
            Json.parseToJsonElement(
                """{"kind":"vrm","vrm":{"model":{"url":"/character-assets/1/vrm/model","sha256":"$sha","bytes":5,"uploaded_at":"x"},"clips":[]}}""",
            ).jsonObject,
        )
        return AuthedCharacterAssetHandler(resolver)
    }

    @Test
    fun `a served model is the file with its type`() {
        val response = handler(200).handle("1/vrm/model")
        assertThat(response.statusCode).isEqualTo(200)
        assertThat(response.mimeType).isEqualTo("model/gltf-binary")
        assertThat(response.data.readBytes()).isEqualTo(model)
        assertThat(response.responseHeaders["Cache-Control"]).isEqualTo("no-store")
    }

    @Test
    fun `a refusal keeps its status and says why`() {
        val response = handler(401).handle("1/vrm/model")
        assertThat(response.statusCode).isEqualTo(401)
        assertThat(response.reasonPhrase).isNotEmpty()
        assertThat(response.data.readBytes()).isEmpty()
        assertThat(handler(200).handle("9/vrm/model").statusCode).isEqualTo(404)
    }

    @Test
    fun `the page's origin answers only the page and its assets`() {
        assertThat(isAllowedPagePath("/assets/character/index.html")).isTrue()
        assertThat(isAllowedPagePath("/character-assets/1/vrm/model")).isTrue()
        assertThat(isAllowedPagePath("/assets/silero_vad.onnx")).isFalse()
        assertThat(isAllowedPagePath("/res/raw/start_effect.wav")).isFalse()
        assertThat(isAllowedPagePath("/assets/character/../silero_vad.onnx")).isFalse()
        assertThat(forbidden().statusCode).isEqualTo(403)
    }
}
