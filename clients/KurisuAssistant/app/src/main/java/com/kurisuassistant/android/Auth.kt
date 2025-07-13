package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences

object Auth {
    private const val PREFS = "auth"
    private const val TOKEN_KEY = "token"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    var token: String?
        get() = prefs.getString(TOKEN_KEY, null)
        set(value) { prefs.edit().putString(TOKEN_KEY, value).apply() }
}
