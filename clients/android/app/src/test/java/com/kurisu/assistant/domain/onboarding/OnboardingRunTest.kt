package com.kurisu.assistant.domain.onboarding

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.model.UnavailableProvider
import com.kurisu.assistant.domain.drive.UploadSource
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Onboarding a new account (#342): the same rules as the desktop's
 * `@kurisu/state` `onboarding.ts` — which steps apply, what finishing writes
 * and in what order, a retry that goes on from where it stopped.
 */
class OnboardingRunTest {

    private class FakeApi : OnboardingApi {
        val calls = mutableListOf<Pair<String, Any?>>()
        var failUpload = false
        var models = ModelsResponse(listOf(ModelInfo("qwen3:8b", "ollama")))

        override suspend fun patchProfile(body: JsonObject) { calls += "profile" to body }
        override suspend fun models(): ModelsResponse = models
        override suspend fun createPersona(data: PersonaCreate): Persona {
            calls += "persona" to data
            return Persona(id = 7, name = data.name)
        }
        override suspend fun uploadVrm(personaId: Int, source: UploadSource, onProgress: (Long, Long?) -> Unit) {
            if (failUpload) throw IOException("The model is too large.")
            calls += "model" to personaId
        }
        override suspend fun patchAssistant(body: JsonObject) { calls += "assistant" to body }
    }

    private val vrm = object : UploadSource {
        override val name = "kurisu.vrm"
        override val size: Long = 3
        override fun open() = ByteArrayInputStream(byteArrayOf(1, 2, 3))
    }

    private val withPersona = OnboardingChoices(
        model = ModelInfo("qwen3:8b", "ollama"),
        persona = PersonaChoice(name = "Kurisu", preferredName = "Okabe", avatarUuid = "img-1", voice = "voice-a", vrm = vrm),
        wakeWord = "Kurisu",
    )

    @Test
    fun `voice and character are asked only with a persona`() {
        assertThat(onboardingSteps(withPersona = true)).containsExactly(
            OnboardingStep.MODEL, OnboardingStep.PERSONA, OnboardingStep.VOICE, OnboardingStep.CHARACTER, OnboardingStep.WAKE_WORD,
        ).inOrder()
        assertThat(onboardingSteps(withPersona = false)).containsExactly(
            OnboardingStep.MODEL, OnboardingStep.PERSONA, OnboardingStep.WAKE_WORD,
        ).inOrder()
    }

    @Test
    fun `the wake word starts as the persona's name, and empty without one`() {
        assertThat(defaultWakeWord("Kurisu")).isEqualTo("Kurisu")
        assertThat(defaultWakeWord("  ")).isEqualTo("")
        assertThat(defaultWakeWord(null)).isEqualTo("")
    }

    @Test
    fun `finishing writes the persona, its model, the account, then the flag`() = runTest {
        val api = FakeApi()
        val parts = mutableListOf<FinishPart>()
        val result = OnboardingRun(api).finish(withPersona, onPart = { parts += it })

        assertThat(result).isEqualTo(7)
        assertThat(api.calls.map { it.first }).containsExactly("persona", "model", "assistant", "profile").inOrder()
        assertThat(api.calls[0].second).isEqualTo(
            PersonaCreate(name = "Kurisu", preferredName = "Okabe", voiceReference = "voice-a", avatarUuid = "img-1"),
        )
        assertThat(api.calls[2].second).isEqualTo(
            JsonObject(
                mapOf(
                    "model_name" to JsonPrimitive("qwen3:8b"),
                    "provider_type" to JsonPrimitive("ollama"),
                    "selected_persona_id" to JsonPrimitive(7),
                    "trigger_word" to JsonPrimitive("Kurisu"),
                ),
            ),
        )
        assertThat(api.calls[3].second).isEqualTo(JsonObject(mapOf("onboarded" to JsonPrimitive(true))))
        assertThat(parts).containsExactly(FinishPart.PERSONA, FinishPart.CHARACTER, FinishPart.ASSISTANT, FinishPart.DONE).inOrder()
    }

    @Test
    fun `without a persona the assistant answers as itself, and an empty wake word is none`() = runTest {
        val api = FakeApi()
        assertThat(OnboardingRun(api).finish(OnboardingChoices(model = null, persona = null, wakeWord = " "))).isNull()
        assertThat(api.calls.map { it.first }).containsExactly("assistant", "profile").inOrder()
        // Explicit nulls: the persona in use and the wake word are cleared, not left alone.
        assertThat(api.calls[0].second).isEqualTo(
            JsonObject(mapOf("selected_persona_id" to JsonNull, "trigger_word" to JsonNull)),
        )
    }

    @Test
    fun `a retry goes on from where it stopped and never makes a second persona`() = runTest {
        val api = FakeApi().apply { failUpload = true }
        val run = OnboardingRun(api)
        assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { run.finish(withPersona) } }
        assertThat(run.failedAt).isEqualTo(FinishPart.CHARACTER)

        api.failUpload = false
        run.finish(withPersona)
        assertThat(api.calls.map { it.first }).containsExactly("persona", "model", "assistant", "profile").inOrder()
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
