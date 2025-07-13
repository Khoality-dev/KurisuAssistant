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

    private const val DEFAULT_LLM_URL = "http://127.0.0.1:15597"
    private const val DEFAULT_TTS_URL = "http://127.0.0.1:15598"

    private lateinit var prefs: SharedPreferences

    var llmUrl: String = DEFAULT_LLM_URL
        private set
    var ttsUrl: String = DEFAULT_TTS_URL
        private set
    var model: String = ""

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        llmUrl = prefs.getString(KEY_LLM_URL, DEFAULT_LLM_URL) ?: DEFAULT_LLM_URL
        ttsUrl = prefs.getString(KEY_TTS_URL, DEFAULT_TTS_URL) ?: DEFAULT_TTS_URL
        model = prefs.getString(KEY_MODEL, "") ?: ""
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
}
