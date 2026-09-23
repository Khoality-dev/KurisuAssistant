package com.kurisu.assistant.data.repository

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.local.PreferencesDataStore
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.model.Conversation
import com.kurisu.assistant.data.remote.api.KurisuApiService
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Test

/**
 * A persona is optional (#302): the assistant answers as itself, so the two
 * pieces of plumbing that only ever spoke of personas learn to say "nobody".
 */
class PersonaOptionalRepositoryTest {

    private val api: KurisuApiService = mockk(relaxed = true)
    private val prefs: PreferencesDataStore = mockk(relaxed = true)

    @Test
    fun `clearing the default sends an explicit null, and nothing else`() = runTest {
        coEvery { api.patchAssistant(any()) } returns Assistant(id = 1, defaultPersonaId = null)

        val updated = AssistantRepository(api).clearDefaultPersona()

        // An absent key means "leave it alone" on this route; only an explicit
        // null clears the column, which no AssistantUpdate field can express.
        coVerify(exactly = 1) { api.patchAssistant(JsonObject(mapOf("default_persona_id" to JsonNull))) }
        assertThat(updated.defaultPersonaId).isNull()
    }

    @Test
    fun `the assistant's own last conversation is cached apart from every persona's`() = runTest {
        val repo = PersonaRepository(api, prefs, ConversationRepository(api))

        repo.setConversationIdForPersona(null, 77)

        coVerify(exactly = 1) { prefs.setPersonaConversationId(PersonaRepository.ASSISTANT_KEY, 77) }
        assertThat(PersonaRepository.ASSISTANT_KEY).isEqualTo(0) // persona ids start at 1
    }

    @Test
    fun `a miss for the assistant finds its latest conversation, not a persona's`() = runTest {
        coEvery { prefs.getPersonaConversationId(PersonaRepository.ASSISTANT_KEY) } returns null
        coEvery { api.getConversations(null) } returns listOf(
            Conversation(id = 9, personaId = 3),
            Conversation(id = 8, personaId = null),
            Conversation(id = 7, personaId = null),
        )
        val repo = PersonaRepository(api, prefs, ConversationRepository(api))

        assertThat(repo.getConversationIdForPersona(null)).isEqualTo(8)
        coVerify(exactly = 1) { prefs.setPersonaConversationId(PersonaRepository.ASSISTANT_KEY, 8) }
    }
}
