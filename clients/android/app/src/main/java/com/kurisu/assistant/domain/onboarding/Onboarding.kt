package com.kurisu.assistant.domain.onboarding

import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.model.ModelsResponse
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Onboarding a new account (#342): the model, and only the model (#376),
 * offered once while `GET /users/me` says `onboarding_pending`. Once it has a
 * model the assistant can be asked for the rest — a persona, a voice, a wake
 * word — so onboarding asks for nothing else.
 *
 * The model is the account's, shared by the assistant and every persona. The
 * provider is saved as soon as it is connected, since the server must hold it
 * before it can list that provider's models; the model is saved on finishing.
 * Finishing or skipping ends the flow for the account, on every device. These
 * are the desktop's rules (`@kurisu/state` `onboarding.ts`).
 */

/** A provider the account can connect, and the profile field that holds it. */
data class OnboardingProvider(val id: String, val label: String, val field: String, val input: String)

val ONBOARDING_PROVIDERS = listOf(
    OnboardingProvider("ollama", "Ollama", "ollama_url", "Ollama address"),
    OnboardingProvider("gemini", "Google Gemini", "gemini_api_key", "API key"),
    OnboardingProvider("nvidia", "NVIDIA NIM", "nvidia_api_key", "API key"),
    OnboardingProvider("poe", "Poe", "poe_api_key", "API key"),
)

/** The calls the flow makes; `OnboardingRepository` makes them for real. */
interface OnboardingApi {
    suspend fun patchProfile(body: JsonObject)
    suspend fun models(): ModelsResponse
    suspend fun patchAssistant(body: JsonObject)
}

private val ONBOARDED = JsonObject(mapOf("onboarded" to JsonPrimitive(true)))

/**
 * Finish: save [model] for the account, then end the flow. A failed save ends
 * nothing, so trying again simply saves it again.
 */
suspend fun finishOnboarding(api: OnboardingApi, model: ModelInfo) {
    api.patchAssistant(
        JsonObject(mapOf("model_name" to JsonPrimitive(model.name), "provider_type" to JsonPrimitive(model.provider))),
    )
    api.patchProfile(ONBOARDED)
}

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
