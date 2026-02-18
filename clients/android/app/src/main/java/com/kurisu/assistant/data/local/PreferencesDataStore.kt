package com.kurisu.assistant.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "kurisu_prefs")

@Singleton
class PreferencesDataStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val ds get() = context.dataStore

    // Keys
    private val KEY_REMEMBER_ME = booleanPreferencesKey(StorageKeys.REMEMBER_ME)
    private val KEY_SELECTED_MODEL = stringPreferencesKey(StorageKeys.SELECTED_MODEL)
    private val KEY_TTS_VOICE = stringPreferencesKey(StorageKeys.TTS_VOICE)
    private val KEY_TTS_LANGUAGE = stringPreferencesKey(StorageKeys.TTS_LANGUAGE)
    private val KEY_TTS_BACKEND = stringPreferencesKey(StorageKeys.TTS_BACKEND)
    private val KEY_TTS_EMO_AUDIO = stringPreferencesKey(StorageKeys.TTS_EMO_AUDIO)
    private val KEY_TTS_EMO_ALPHA = floatPreferencesKey(StorageKeys.TTS_EMO_ALPHA)
    private val KEY_TTS_USE_EMO_TEXT = booleanPreferencesKey(StorageKeys.TTS_USE_EMO_TEXT)
    private val KEY_BACKEND_URL = stringPreferencesKey(StorageKeys.BACKEND_URL)
    private val KEY_SELECTED_AGENT_ID = intPreferencesKey(StorageKeys.SELECTED_AGENT_ID)
    private val KEY_AGENT_CONVERSATIONS = stringPreferencesKey(StorageKeys.AGENT_CONVERSATIONS)
    private val KEY_MEDIA_VOLUME = floatPreferencesKey(StorageKeys.MEDIA_VOLUME)
    private val KEY_AUDIO_INPUT_DEVICE_TYPE = intPreferencesKey(StorageKeys.AUDIO_INPUT_DEVICE_TYPE)
    private val KEY_ASR_LANGUAGE = stringPreferencesKey(StorageKeys.ASR_LANGUAGE)

    companion object {
        const val DEFAULT_BACKEND_URL = "http://localhost:15597"
    }

    // Remember Me
    suspend fun getRememberMe(): Boolean = ds.data.first()[KEY_REMEMBER_ME] ?: false
    suspend fun setRememberMe(value: Boolean) { ds.edit { it[KEY_REMEMBER_ME] = value } }

    // Backend URL
    suspend fun getBackendUrl(): String = ds.data.first()[KEY_BACKEND_URL] ?: DEFAULT_BACKEND_URL
    fun backendUrlFlow(): Flow<String> = ds.data.map { it[KEY_BACKEND_URL] ?: DEFAULT_BACKEND_URL }
    suspend fun setBackendUrl(url: String) { ds.edit { it[KEY_BACKEND_URL] = url } }

    // Selected Model
    suspend fun getSelectedModel(): String? = ds.data.first()[KEY_SELECTED_MODEL]
    suspend fun setSelectedModel(model: String) { ds.edit { it[KEY_SELECTED_MODEL] = model } }

    // TTS
    suspend fun getTTSVoice(): String? = ds.data.first()[KEY_TTS_VOICE]
    suspend fun setTTSVoice(voice: String) { ds.edit { it[KEY_TTS_VOICE] = voice } }

    suspend fun getTTSLanguage(): String? = ds.data.first()[KEY_TTS_LANGUAGE]
    suspend fun setTTSLanguage(language: String) { ds.edit { it[KEY_TTS_LANGUAGE] = language } }

    suspend fun getTTSBackend(): String? = ds.data.first()[KEY_TTS_BACKEND]
    suspend fun setTTSBackend(backend: String) { ds.edit { it[KEY_TTS_BACKEND] = backend } }

    suspend fun getTTSEmotionAudio(): String? = ds.data.first()[KEY_TTS_EMO_AUDIO]
    suspend fun setTTSEmotionAudio(audio: String) { ds.edit { it[KEY_TTS_EMO_AUDIO] = audio } }

    suspend fun getTTSEmotionAlpha(): Float? = ds.data.first()[KEY_TTS_EMO_ALPHA]
    suspend fun setTTSEmotionAlpha(alpha: Float) { ds.edit { it[KEY_TTS_EMO_ALPHA] = alpha } }

    suspend fun getTTSUseEmotionText(): Boolean? = ds.data.first()[KEY_TTS_USE_EMO_TEXT]
    suspend fun setTTSUseEmotionText(use: Boolean) { ds.edit { it[KEY_TTS_USE_EMO_TEXT] = use } }

    // Selected Agent
    suspend fun getSelectedAgentId(): Int? = ds.data.first()[KEY_SELECTED_AGENT_ID]
    suspend fun setSelectedAgentId(id: Int) { ds.edit { it[KEY_SELECTED_AGENT_ID] = id } }
    suspend fun clearSelectedAgentId() { ds.edit { it.remove(KEY_SELECTED_AGENT_ID) } }

    // Agent-Conversation Mapping (JSON map: agentId -> conversationId)
    suspend fun getAgentConversationMap(): Map<Int, Int> {
        val json = ds.data.first()[KEY_AGENT_CONVERSATIONS] ?: return emptyMap()
        return try {
            Json.decodeFromString<Map<String, Int>>(json).mapKeys { it.key.toInt() }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    suspend fun getAgentConversationId(agentId: Int): Int? = getAgentConversationMap()[agentId]

    suspend fun setAgentConversationId(agentId: Int, conversationId: Int) {
        val map = getAgentConversationMap().toMutableMap()
        map[agentId] = conversationId
        val json = Json.encodeToString(
            kotlinx.serialization.serializer<Map<String, Int>>(),
            map.mapKeys { it.key.toString() }
        )
        ds.edit { it[KEY_AGENT_CONVERSATIONS] = json }
    }

    suspend fun clearAgentConversationId(agentId: Int) {
        val map = getAgentConversationMap().toMutableMap()
        map.remove(agentId)
        val json = Json.encodeToString(
            kotlinx.serialization.serializer<Map<String, Int>>(),
            map.mapKeys { it.key.toString() }
        )
        ds.edit { it[KEY_AGENT_CONVERSATIONS] = json }
    }

    suspend fun clearAllAgentConversations() { ds.edit { it.remove(KEY_AGENT_CONVERSATIONS) } }

    // Media Volume
    suspend fun getMediaVolume(): Float = ds.data.first()[KEY_MEDIA_VOLUME] ?: 1.0f
    suspend fun setMediaVolume(volume: Float) { ds.edit { it[KEY_MEDIA_VOLUME] = volume } }

    // Audio Input Device Type (-1 = default/auto)
    suspend fun getAudioInputDeviceType(): Int = ds.data.first()[KEY_AUDIO_INPUT_DEVICE_TYPE] ?: -1
    suspend fun setAudioInputDeviceType(type: Int) { ds.edit { it[KEY_AUDIO_INPUT_DEVICE_TYPE] = type } }

    // ASR Language (empty = auto-detect)
    suspend fun getAsrLanguage(): String = ds.data.first()[KEY_ASR_LANGUAGE] ?: ""
    suspend fun setAsrLanguage(language: String) { ds.edit { it[KEY_ASR_LANGUAGE] = language } }
}
