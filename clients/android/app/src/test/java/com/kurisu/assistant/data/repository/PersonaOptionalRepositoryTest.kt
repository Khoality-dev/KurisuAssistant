package com.kurisu.assistant.data.repository

import com.google.common.truth.Truth.assertThat
import com.kurisu.assistant.data.model.Assistant
import com.kurisu.assistant.data.remote.api.KurisuApiService
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Test

/**
 * A persona is optional (#302): the assistant answers as itself, so the
 * selection has to be able to say "nobody".
 */
class PersonaOptionalRepositoryTest {

    private val api: KurisuApiService = mockk(relaxed = true)

    @Test
    fun `selecting the assistant sends an explicit null, and nothing else`() = runTest {
        coEvery { api.patchAssistant(any()) } returns Assistant(id = 1, selectedPersonaId = null)

        val updated = AssistantRepository(api).clearSelectedPersona()

        // An absent key means "leave it alone" on this route; only an explicit
        // null clears the column, which no AssistantUpdate field can express.
        coVerify(exactly = 1) { api.patchAssistant(JsonObject(mapOf("selected_persona_id" to JsonNull))) }
        assertThat(updated.selectedPersonaId).isNull()
    }
}
