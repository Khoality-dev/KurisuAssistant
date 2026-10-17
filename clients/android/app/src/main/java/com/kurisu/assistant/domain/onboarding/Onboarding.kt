package com.kurisu.assistant.domain.onboarding

import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.domain.drive.UploadSource
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Onboarding a new account (#342): the model, an optional first persona, and
 * the wake word, offered once while `GET /users/me` says `onboarding_pending`.
 *
 * The model and the wake word are the account's, shared by the assistant and
 * every persona; the persona only changes who speaks. Nothing the user picks is
 * written until they finish — except a provider they connect, which the server
 * must hold before it can list that provider's models. Finishing or skipping
 * ends the flow for the account, on every device. These are the desktop's rules
 * (`@kurisu/state` `onboarding.ts`).
 */

enum class OnboardingStep(val title: String) {
    MODEL("Model"),
    PERSONA("Persona"),
    VOICE("Voice"),
    CHARACTER("Character"),
    WAKE_WORD("Wake word"),
}

/** The steps in order. Voice and character belong to a persona and are skipped without one. */
fun onboardingSteps(withPersona: Boolean): List<OnboardingStep> =
    if (withPersona) OnboardingStep.entries
    else listOf(OnboardingStep.MODEL, OnboardingStep.PERSONA, OnboardingStep.WAKE_WORD)

/** The wake word starts as the persona's name, and empty without one. */
fun defaultWakeWord(personaName: String?): String = personaName?.trim().orEmpty()

/** A provider the account can connect, and the profile field that holds it. */
data class OnboardingProvider(val id: String, val label: String, val field: String, val input: String)

val ONBOARDING_PROVIDERS = listOf(
    OnboardingProvider("ollama", "Ollama", "ollama_url", "Ollama address"),
    OnboardingProvider("gemini", "Google Gemini", "gemini_api_key", "API key"),
    OnboardingProvider("nvidia", "NVIDIA NIM", "nvidia_api_key", "API key"),
    OnboardingProvider("poe", "Poe", "poe_api_key", "API key"),
)

data class PersonaChoice(
    val name: String,
    val preferredName: String,
    val avatarUuid: String?,
    val voice: String?,
    /** A `.vrm` to make its character; null for none yet. */
    val vrm: UploadSource?,
)

data class OnboardingChoices(
    /** Null leaves the account without one; the chat asks at the first message. */
    val model: ModelInfo?,
    /** Null: the assistant answers as itself. */
    val persona: PersonaChoice?,
    /** Empty for no wake word. */
    val wakeWord: String,
)

/** The calls the flow makes; `OnboardingRepository` makes them for real. */
interface OnboardingApi {
    suspend fun patchProfile(body: JsonObject)
    suspend fun models(): ModelsResponse
    suspend fun createPersona(data: PersonaCreate): Persona
    suspend fun uploadVrm(personaId: Int, source: UploadSource, onProgress: (Long, Long?) -> Unit)
    /** A raw body: clearing the persona in use and the wake word needs explicit nulls. */
    suspend fun patchAssistant(body: JsonObject)
}

/** What finishing is doing now, for the progress screen. */
enum class FinishPart { PERSONA, CHARACTER, ASSISTANT, DONE }

/**
 * Finishing, as one retryable run: each part is done once, so a retry after a
 * failed upload goes on from there instead of making a second persona.
 */
class OnboardingRun(private val api: OnboardingApi) {
    private var personaId: Int? = null
    private val done = mutableSetOf<FinishPart>()

    /** The part the last attempt stopped at, or null. */
    var failedAt: FinishPart? = null
        private set

    /** Finish with [choices]; answers the new persona's id, or null without one. */
    suspend fun finish(
        choices: OnboardingChoices,
        onPart: (FinishPart) -> Unit = {},
        onUploadProgress: (Long, Long?) -> Unit = { _, _ -> },
    ): Int? {
        failedAt = null
        val persona = choices.persona
        if (persona != null) {
            step(FinishPart.PERSONA, onPart) {
                personaId = api.createPersona(
                    PersonaCreate(
                        name = persona.name.trim(),
                        preferredName = persona.preferredName.trim().ifEmpty { null },
                        voiceReference = persona.voice,
                        avatarUuid = persona.avatarUuid,
                    ),
                ).id
            }
            val vrm = persona.vrm
            if (vrm != null) step(FinishPart.CHARACTER, onPart) { api.uploadVrm(personaId!!, vrm, onUploadProgress) }
        }
        step(FinishPart.ASSISTANT, onPart) {
            val wake = choices.wakeWord.trim()
            val fields = buildMap {
                choices.model?.let {
                    put("model_name", JsonPrimitive(it.name))
                    put("provider_type", JsonPrimitive(it.provider))
                }
                put("selected_persona_id", if (persona != null) JsonPrimitive(personaId) else JsonNull)
                put("trigger_word", if (wake.isNotEmpty()) JsonPrimitive(wake) else JsonNull)
            }
            api.patchAssistant(JsonObject(fields))
        }
        api.patchProfile(ONBOARDED)
        onPart(FinishPart.DONE)
        return if (persona != null) personaId else null
    }

    private suspend fun step(part: FinishPart, onPart: (FinishPart) -> Unit, work: suspend () -> Unit) {
        if (part in done) return
        onPart(part)
        try {
            work()
        } catch (e: Exception) {
            failedAt = part
            throw e
        }
        done += part
    }
}

private val ONBOARDED = JsonObject(mapOf("onboarded" to JsonPrimitive(true)))

/** Skip: nothing from the flow is kept, and nothing asks again on any device. */
suspend fun skipOnboarding(api: OnboardingApi) = api.patchProfile(ONBOARDED)

data class ConnectResult(val models: List<ModelInfo>, val problem: String?)

/**
 * Connect [providerId] with [value] (an address for Ollama, a key otherwise)
 * and list its models. The server keeps the provider: that is how it lists them.
 */
suspend fun connectProvider(api: OnboardingApi, providerId: String, value: String): ConnectResult {
    val provider = ONBOARDING_PROVIDERS.first { it.id == providerId }
    val trimmed = value.trim()
    if (trimmed.isEmpty()) {
        return ConnectResult(emptyList(), if (providerId == "ollama") "Enter the Ollama address first." else "Enter the API key first.")
    }
    api.patchProfile(JsonObject(mapOf(provider.field to JsonPrimitive(trimmed))))
    val response = api.models()
    val mine = response.models.filter { it.provider == providerId }
    if (mine.isNotEmpty()) return ConnectResult(mine, null)
    val why = response.unavailable.firstOrNull { it.provider == providerId }?.detail
    return ConnectResult(emptyList(), why ?: "That provider has no models yet.")
}
