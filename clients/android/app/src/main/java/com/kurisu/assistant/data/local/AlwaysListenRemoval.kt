package com.kurisu.assistant.data.local

import androidx.datastore.core.DataMigration
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey

/**
 * Removes "Always listen" from the store (#341). Voice mode replaced it, and the
 * mic no longer listens outside voice mode, so the setting means nothing. It is
 * deleted once here rather than kept and ignored; voice mode itself starts off,
 * whatever it said.
 */
object AlwaysListenRemoval : DataMigration<Preferences> {
    private val ALWAYS_LISTEN = booleanPreferencesKey("kurisu_asr_always_listen")

    override suspend fun shouldMigrate(currentData: Preferences): Boolean = ALWAYS_LISTEN in currentData

    override suspend fun migrate(currentData: Preferences): Preferences =
        currentData.toMutablePreferences().apply { remove(ALWAYS_LISTEN) }.toPreferences()

    override suspend fun cleanUp() {}
}
