package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.AssistantUpdate
import com.kurisu.assistant.data.model.ModelInfo
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The user's single assistant: what it can do, and who answers by default.
 *
 * There is exactly one per user and it is created at registration, so there is
 * no create and no delete — only read and patch. It owns model, provider, tools,
 * reasoning, memory, `default_persona_id`, and `trigger_word`, which is a voice
 * WAKE word: it wakes the assistant and selects no persona.
 */
@Singleton
class AssistantRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun getAssistant(): Assistant = api.getAssistant()

    /**
     * Patch the assistant. Fields left null are omitted from the request body,
     * not sent as null — the backend reads the body through `model_fields_set`
     * and several of these columns reject an explicit null.
     */
    suspend fun updateAssistant(data: AssistantUpdate): Assistant = api.updateAssistant(data)

    /** Models available to the assistant (and to sub-agents). */
    suspend fun listModels(): List<ModelInfo> = api.getModels().models
}
