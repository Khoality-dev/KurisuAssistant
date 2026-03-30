package com.kurisu.assistant.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class EncryptedPreferences @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            "kurisu_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun getToken(): String? = prefs.getString(StorageKeys.AUTH_TOKEN, null)

    fun setToken(token: String) {
        prefs.edit().putString(StorageKeys.AUTH_TOKEN, token).apply()
    }

    fun clearToken() {
        prefs.edit().remove(StorageKeys.AUTH_TOKEN).apply()
    }

    fun getRefreshToken(): String? = prefs.getString(StorageKeys.REFRESH_TOKEN, null)

    fun setRefreshToken(token: String) {
        prefs.edit().putString(StorageKeys.REFRESH_TOKEN, token).apply()
    }

    fun clearRefreshToken() {
        prefs.edit().remove(StorageKeys.REFRESH_TOKEN).apply()
    }
}
