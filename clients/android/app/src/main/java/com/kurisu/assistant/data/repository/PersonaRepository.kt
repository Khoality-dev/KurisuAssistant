package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.Persona
import com.kurisu.assistant.data.model.PersonaCreate
import com.kurisu.assistant.data.model.PersonaUpdate
import com.kurisu.assistant.data.model.EnabledUpdate
import com.kurisu.assistant.data.remote.api.KurisuApiService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Personas: how the assistant looks and sounds. A persona is optional (#302) —
 * with none, the assistant answers as itself — and one persona, or none, is in
 * use for the whole account (#354), named by the assistant's
 * `selected_persona_id`. A conversation is not tied to one.
 *
 * A persona owns presentation only — name, prompt, voice, face. Model, tools,
 * memory and the voice wake word belong to [AssistantRepository].
 */
@Singleton
class PersonaRepository @Inject constructor(
    private val api: KurisuApiService,
) {
    suspend fun listPersonas(): List<Persona> = api.listPersonas()

    suspend fun getPersona(id: Int): Persona = api.getPersona(id)

    suspend fun createPersona(data: PersonaCreate): Persona = api.createPersona(data)

    suspend fun updatePersona(id: Int, data: PersonaUpdate): Persona = api.updatePersona(id, data)

    suspend fun deletePersona(id: Int) = api.deletePersona(id)

    suspend fun setPersonaEnabled(id: Int, enabled: Boolean): Persona =
        api.setPersonaEnabled(id, EnabledUpdate(enabled))

    fun getImageUrl(baseUrl: String, uuid: String): String =
        "${baseUrl.trimEnd('/')}/images/$uuid"
}
