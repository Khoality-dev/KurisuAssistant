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
 * A persona is optional (#302) — with none, the assistant answers as itself —
 * so the conversation cache also keeps the assistant's own, under [ASSISTANT_KEY].
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
     * The conversation this persona last spoke in; with [personaId] null, the
     * one the assistant last spoke in as itself (#302).
     *
     * The local map is only a cache, so a miss falls back to the backend and
     * re-caches — which is what lets the storage key be renamed with no client
     * migration, and what lets a second device catch up. The backend cannot
     * filter on "no persona", so the assistant's miss reads the recent
     * conversations and takes the newest one nobody is bound to.
     */
    suspend fun getConversationIdForPersona(personaId: Int?): Int? {
        val key = personaId ?: ASSISTANT_KEY
        val localId = prefs.getPersonaConversationId(key)
        if (localId != null) return localId

        val conv = if (personaId != null) {
            conversationRepository.getLatestConversationForPersona(personaId)
        } else {
            conversationRepository.getConversations().firstOrNull { it.personaId == null }
        }
        if (conv != null) {
            prefs.setPersonaConversationId(key, conv.id)
            return conv.id
        }

        return null
    }

    suspend fun setConversationIdForPersona(personaId: Int?, conversationId: Int) {
        prefs.setPersonaConversationId(personaId ?: ASSISTANT_KEY, conversationId)
    }

    suspend fun clearConversationIdForPersona(personaId: Int?) {
        prefs.clearPersonaConversationId(personaId ?: ASSISTANT_KEY)
    }

    fun getImageUrl(baseUrl: String, uuid: String): String =
        "${baseUrl.trimEnd('/')}/images/$uuid"

    companion object {
        /**
         * The conversation cache's key for the assistant answering as itself.
         * Persona ids are database serials starting at 1, so 0 names nobody.
         */
        const val ASSISTANT_KEY = 0
    }
}
