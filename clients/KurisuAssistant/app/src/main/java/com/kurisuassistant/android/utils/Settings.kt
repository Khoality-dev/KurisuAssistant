package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences

/**
 * Stores configurable settings like backend URLs and model name.
 */
object Settings {
    private const val PREFS = "settings"
    private const val KEY_LLM_URL = "llm_url"
    private const val KEY_TTS_URL = "tts_url"
    private const val KEY_MODEL = "model"
    private const val KEY_SYSTEM_PROMPT = "system_prompt"
    private const val KEY_FIRST = "first_run"

    private lateinit var prefs: SharedPreferences

    var llmUrl: String = ""
        private set
    var ttsUrl: String = ""
        private set
    var model: String = ""
    var systemPrompt: String = ""
    
    var firstRun: Boolean = true

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        llmUrl = prefs.getString(KEY_LLM_URL, "") ?: ""
        ttsUrl = prefs.getString(KEY_TTS_URL, "") ?: ""
        model = prefs.getString(KEY_MODEL, "") ?: ""
        systemPrompt = prefs.getString(KEY_SYSTEM_PROMPT, "") ?: ""
        firstRun = prefs.getBoolean(KEY_FIRST, true)
    }

    fun save(llm: String, tts: String, modelName: String) {
        llmUrl = llm
        ttsUrl = tts
        model = modelName
        prefs.edit()
            .putString(KEY_LLM_URL, llmUrl)
            .putString(KEY_TTS_URL, ttsUrl)
            .putString(KEY_MODEL, model)
            .apply()
    }

    fun saveSystemPrompt(prompt: String) {
        systemPrompt = prompt
        prefs.edit()
            .putString(KEY_SYSTEM_PROMPT, systemPrompt)
            .apply()
    }

    fun markConfigured() {
        firstRun = false
        prefs.edit().putBoolean(KEY_FIRST, false).apply()
    }

    fun getLlmHubUrl(): String {
        return llmUrl
    }

    fun getToken(): String {
        return Auth.token ?: ""
    }
}
