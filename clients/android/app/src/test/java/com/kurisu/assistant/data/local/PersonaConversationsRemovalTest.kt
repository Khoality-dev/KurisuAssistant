package com.kurisu.assistant.data.local

import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * A conversation is not tied to a persona any more (#354): one persona, or none,
 * is in use for the whole account, so "the last conversation each persona spoke
 * in" means nothing. The cache that kept it (`kurisu_persona_conversations`) is
 * removed from the store once, in a migration, rather than left behind.
 */
class PersonaConversationsRemovalTest {

    private val personaConversations = stringPreferencesKey("kurisu_persona_conversations")

    @Test
    fun `a store with the old cache is migrated, and the cache is gone`() = runTest {
        val before = mutablePreferencesOf(personaConversations to """{"0":8,"3":9}""")

        assertThat(PersonaConversationsRemoval.shouldMigrate(before)).isTrue()
        val after = PersonaConversationsRemoval.migrate(before)

        assertThat(after[personaConversations]).isNull()
    }

    @Test
    fun `a store without it is left alone`() = runTest {
        assertThat(PersonaConversationsRemoval.shouldMigrate(emptyPreferences())).isFalse()
    }
}
