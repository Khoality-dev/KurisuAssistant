package com.kurisu.assistant.domain.onboarding

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.model.UnavailableProvider
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

/**
 * Onboarding a new account (#342), which asks only for the model (#376): the
 * same rules as the desktop's `@kurisu/state` `onboarding.ts`.
 */
class OnboardingRunTest {

    private class FakeApi : OnboardingApi {
        val calls = mutableListOf<Pair<String, Any?>>()
        var failAssistant = false
        var models = ModelsResponse(listOf(ModelInfo("qwen3:8b", "ollama")))

        override suspend fun patchProfile(body: JsonObject) { calls += "profile" to body }
        override suspend fun models(): ModelsResponse = models
        override suspend fun patchAssistant(body: JsonObject) {
            if (failAssistant) throw IOException("offline")
            calls += "assistant" to body
        }
    }

    @Test
    fun `finishing saves the model, and nothing else, then ends the flow`() = runTest {
        val api = FakeApi()
        finishOnboarding(api, ModelInfo("qwen3:8b", "ollama"))
        // No persona, no voice, no wake word: once it has a model, the assistant can be asked for the rest.
        assertThat(api.calls).containsExactly(
            "assistant" to JsonObject(mapOf("model_name" to JsonPrimitive("qwen3:8b"), "provider_type" to JsonPrimitive("ollama"))),
            "profile" to JsonObject(mapOf("onboarded" to JsonPrimitive(true))),
        ).inOrder()
    }

    @Test
    fun `a failed save ends nothing, and trying again saves it`() = runTest {
        val api = FakeApi().apply { failAssistant = true }
        assertThrows(IOException::class.java) {
            kotlinx.coroutines.runBlocking { finishOnboarding(api, ModelInfo("qwen3:8b", "ollama")) }
        }
        assertThat(api.calls).isEmpty()

        api.failAssistant = false
        finishOnboarding(api, ModelInfo("qwen3:8b", "ollama"))
        assertThat(api.calls.map { it.first }).containsExactly("assistant", "profile").inOrder()
    }

    @Test
    fun `skipping keeps nothing and only ends the flow`() = runTest {
        val api = FakeApi()
        skipOnboarding(api)
        assertThat(api.calls).containsExactly("profile" to JsonObject(mapOf("onboarded" to JsonPrimitive(true))))
    }

    @Test
    fun `connecting a provider saves it and lists that provider's models`() = runTest {
        val api = FakeApi().apply {
            models = ModelsResponse(listOf(ModelInfo("qwen3:8b", "ollama"), ModelInfo("gemini-2.5-flash", "gemini")))
        }
        val result = connectProvider(api, "ollama", " http://192.168.1.20:11434 ")
        assertThat(api.calls).containsExactly("profile" to JsonObject(mapOf("ollama_url" to JsonPrimitive("http://192.168.1.20:11434"))))
        assertThat(result).isEqualTo(ConnectResult(listOf(ModelInfo("qwen3:8b", "ollama")), problem = null))

        api.calls.clear()
        connectProvider(api, "gemini", "key-123")
        assertThat(api.calls).containsExactly("profile" to JsonObject(mapOf("gemini_api_key" to JsonPrimitive("key-123"))))
    }

    @Test
    fun `a provider that gives nothing says why, in the server's words`() = runTest {
        val api = FakeApi().apply {
            models = ModelsResponse(emptyList(), listOf(UnavailableProvider("ollama", "Ollama at http://x:11434 could not be reached.")))
        }
        assertThat(connectProvider(api, "ollama", "http://x:11434").problem).isEqualTo("Ollama at http://x:11434 could not be reached.")
        api.models = ModelsResponse(emptyList())
        assertThat(connectProvider(api, "ollama", "http://x:11434").problem).isEqualTo("That provider has no models yet.")
        assertThat(connectProvider(api, "ollama", "  ").problem).isEqualTo("Enter the Ollama address first.")
        assertThat(connectProvider(api, "poe", "").problem).isEqualTo("Enter the API key first.")
    }
}
