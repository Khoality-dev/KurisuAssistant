package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences

object Auth {
    private const val PREFS = "auth"
    private const val TOKEN_KEY = "token"

    private lateinit var prefs: SharedPreferences

    /** Token for the current session, loaded from prefs if available. */
    var token: String? = null
        private set

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (token == null) {
            token = prefs.getString(TOKEN_KEY, null)
        }
    }

    /**
     * Store the token. If [remember] is true the token is persisted in
     * preferences, otherwise it's kept only for the running session.
     */
    fun setToken(value: String, remember: Boolean) {
        token = value
        if (remember) {
            prefs.edit().putString(TOKEN_KEY, value).apply()
        } else {
            prefs.edit().remove(TOKEN_KEY).apply()
        }
    }
}
