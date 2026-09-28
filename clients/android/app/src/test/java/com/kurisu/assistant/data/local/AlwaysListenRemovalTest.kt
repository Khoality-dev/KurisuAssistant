package com.kurisu.assistant.data.local

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Voice mode replaced "Always listen" (#341). The old setting is removed from
 * the store once, in a migration, rather than kept and ignored: it meant "the
 * mic is on outside voice mode", which is no longer a thing. Voice mode itself
 * starts off, whatever "Always listen" was, and is kept under the desktop's
 * key, `kurisu_voice_mode`.
 */
class AlwaysListenRemovalTest {

    private val alwaysListen = booleanPreferencesKey("kurisu_asr_always_listen")

    @Test
    fun `a store with the old setting is migrated, and the setting is gone`() = runTest {
        val before = mutablePreferencesOf(alwaysListen to true)

        assertThat(AlwaysListenRemoval.shouldMigrate(before)).isTrue()
        val after = AlwaysListenRemoval.migrate(before)

        assertThat(after[alwaysListen]).isNull()
        assertThat(after[booleanPreferencesKey(StorageKeys.VOICE_MODE)]).isNull()
    }

    @Test
    fun `a store without it is left alone`() = runTest {
        assertThat(AlwaysListenRemoval.shouldMigrate(emptyPreferences())).isFalse()
    }

    @Test
    fun `voice mode is kept under the same key as the desktop`() {
        assertThat(StorageKeys.VOICE_MODE).isEqualTo("kurisu_voice_mode")
    }
}
