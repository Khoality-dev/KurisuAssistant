package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri

/** Utility object for persisting avatar images. */
object AvatarManager {
    private const val PREFS = "avatars"
    private const val USER_KEY = "user_avatar"
    private const val AGENT_KEY = "agent_avatar"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun setUserAvatar(uri: Uri) {
        prefs.edit().putString(USER_KEY, uri.toString()).apply()
    }

    fun setAgentAvatar(uri: Uri) {
        prefs.edit().putString(AGENT_KEY, uri.toString()).apply()
    }

    fun getUserAvatarUri(): Uri? =
        prefs.getString(USER_KEY, null)?.let { Uri.parse(it) }

    fun getAgentAvatarUri(): Uri? =
        prefs.getString(AGENT_KEY, null)?.let { Uri.parse(it) }
}

