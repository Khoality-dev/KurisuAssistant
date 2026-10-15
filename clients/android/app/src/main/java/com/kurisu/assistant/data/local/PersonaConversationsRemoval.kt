package com.kurisu.assistant.data.local

import androidx.datastore.core.DataMigration
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey

/**
 * Removes the "last conversation per persona" cache from the store (#354). A
 * conversation is not tied to a persona any more — one persona, or none, is in
 * use for the whole account — so the cache means nothing. It is deleted once
 * here rather than left behind; the chat opens the conversation the Chats list
 * chose instead.
 */
object PersonaConversationsRemoval : DataMigration<Preferences> {
    private val PERSONA_CONVERSATIONS = stringPreferencesKey("kurisu_persona_conversations")

    override suspend fun shouldMigrate(currentData: Preferences): Boolean = PERSONA_CONVERSATIONS in currentData

    override suspend fun migrate(currentData: Preferences): Preferences =
        currentData.toMutablePreferences().apply { remove(PERSONA_CONVERSATIONS) }.toPreferences()

    override suspend fun cleanUp() {}
}
