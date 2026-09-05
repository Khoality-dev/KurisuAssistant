package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.model.PersonaUpdate
import com.kurisu.assistant.data.model.EnabledUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Personas: who answers, and which conversation each of them last spoke in.
 *
 * A persona owns presentation only — name, prompt, voice, face. Model, tools,
 * memory and the voice wake word belong to [AssistantRepository]; task-only
 * workers to [SubAgentRepository].
 */
@Singleton
class PersonaRepository @Inject constructor(
    private val api: KurisuApiService,
    private val prefs: PreferencesDataStore,
    private val conversationRepository: ConversationRepository,
) {
    suspend fun listPersonas(): List<Persona> = api.listPersonas()

    suspend fun getPersona(id: Int): Persona = api.getPersona(id)

    suspend fun createPersona(data: PersonaCreate): Persona = api.createPersona(data)

    suspend fun updatePersona(id: Int, data: PersonaUpdate): Persona = api.updatePersona(id, data)

    suspend fun deletePersona(id: Int) = api.deletePersona(id)

    suspend fun setPersonaEnabled(id: Int, enabled: Boolean): Persona =
        api.setPersonaEnabled(id, EnabledUpdate(enabled))

    /**
     * The conversation this persona last spoke in.
     *
     * The local map is only a cache, so a miss falls back to the backend and
     * re-caches — which is what lets the storage key be renamed with no client
     * migration, and what lets a second device catch up.
     */
    suspend fun getConversationIdForPersona(personaId: Int): Int? {
        val localId = prefs.getPersonaConversationId(personaId)
        if (localId != null) return localId

        val conv = conversationRepository.getLatestConversationForPersona(personaId)
        if (conv != null) {
            prefs.setPersonaConversationId(personaId, conv.id)
            return conv.id
        }

        return null
    }

    suspend fun setConversationIdForPersona(personaId: Int, conversationId: Int) {
        prefs.setPersonaConversationId(personaId, conversationId)
    }

    suspend fun clearConversationIdForPersona(personaId: Int) {
        prefs.clearPersonaConversationId(personaId)
    }

    fun getImageUrl(baseUrl: String, uuid: String): String =
        "${baseUrl.trimEnd('/')}/images/$uuid"
}
