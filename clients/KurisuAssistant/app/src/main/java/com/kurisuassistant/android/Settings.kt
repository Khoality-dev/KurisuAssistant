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

    private lateinit var prefs: SharedPreferences

    var llmUrl: String = BuildConfig.LLM_URL
        private set
    var ttsUrl: String = BuildConfig.TTS_URL
        private set
    var model: String = BuildConfig.DEFAULT_MODEL
        private set

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        llmUrl = prefs.getString(KEY_LLM_URL, BuildConfig.LLM_URL) ?: BuildConfig.LLM_URL
        ttsUrl = prefs.getString(KEY_TTS_URL, BuildConfig.TTS_URL) ?: BuildConfig.TTS_URL
        model = prefs.getString(KEY_MODEL, BuildConfig.DEFAULT_MODEL) ?: BuildConfig.DEFAULT_MODEL
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
