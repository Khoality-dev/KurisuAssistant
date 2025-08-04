package com.kurisuassistant.android

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** Utility object for persisting avatar images. */
object AvatarManager {
    private const val PREFS = "avatars"
    private const val USER_KEY = "user_avatar"
    private const val AGENT_KEY = "agent_avatar"
    private const val USER_UUID_KEY = "user_avatar_uuid"
    private const val AGENT_UUID_KEY = "agent_avatar_uuid"
    private const val TAG = "AvatarManager"

    private lateinit var prefs: SharedPreferences
    private lateinit var appContext: Context
    private val client = OkHttpClient()
    
    // Callback for avatar changes
    private var avatarChangeListener: (() -> Unit)? = null

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        appContext = context.applicationContext
        
        // Check for avatar updates on initialization
        checkAvatarUpdates()
    }
    
    private fun checkAvatarUpdates() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val token = Auth.token ?: return@launch
                
                val request = Request.Builder()
                    .url("${Settings.llmUrl}/user")
                    .addHeader("Authorization", "Bearer $token")
                    .build()
                
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return@launch
                    
                    val json = JSONObject(resp.body!!.string())
                    val serverUserUuid = if (json.isNull("user_avatar_uuid")) null else json.optString("user_avatar_uuid")
                    val serverAgentUuid = if (json.isNull("agent_avatar_uuid")) null else json.optString("agent_avatar_uuid")
                    
                    val localUserUuid = getUserAvatarUuid()
                    val localAgentUuid = getAgentAvatarUuid()
                    
                    // Check user avatar - only download if server has a valid UUID and it's different from local
                    if (serverUserUuid != null && serverUserUuid.isNotEmpty() && serverUserUuid != "null" && serverUserUuid != localUserUuid) {
                        downloadAndSetAvatar(serverUserUuid, "user")
                        Log.d(TAG, "Updated user avatar: $serverUserUuid")
                    } else if (serverUserUuid == null && localUserUuid != null) {
                        clearUserAvatar()
                        Log.d(TAG, "Cleared user avatar")
                    }
                    
                    // Check agent avatar - only download if server has a valid UUID and it's different from local
                    if (serverAgentUuid != null && serverAgentUuid.isNotEmpty() && serverAgentUuid != "null" && serverAgentUuid != localAgentUuid) {
                        downloadAndSetAvatar(serverAgentUuid, "agent")
                        Log.d(TAG, "Updated agent avatar: $serverAgentUuid")
                    } else if (serverAgentUuid == null && localAgentUuid != null) {
                        clearAgentAvatar()
                        Log.d(TAG, "Cleared agent avatar")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to check avatar updates", e)
            }
        }
    }
    
    private suspend fun downloadAndSetAvatar(uuid: String, type: String) {
        try {
            val token = Auth.token ?: return
            
            val request = Request.Builder()
                .url("${Settings.llmUrl}/images/$uuid")
                .addHeader("Authorization", "Bearer $token")
                .build()
            
            // Perform network operations on IO dispatcher
            withContext(Dispatchers.IO) {
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return@withContext
                    
                    val avatarsDir = File(appContext.cacheDir, "avatars")
                    if (!avatarsDir.exists()) {
                        avatarsDir.mkdirs()
                    }
                    
                    val file = File(avatarsDir, "${type}_avatar.jpg")
                    
                    resp.body!!.byteStream().use { input ->
                        FileOutputStream(file).use { output ->
                            input.copyTo(output)
                        }
                    }
                    
                    val uri = Uri.fromFile(file)
                    
                    // Switch back to main thread for UI updates
                    withContext(Dispatchers.Main) {
                        if (type == "user") {
                            setUserAvatar(uri, uuid)
                        } else {
                            setAgentAvatar(uri, uuid)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to download avatar $uuid", e)
        }
    }

    fun setUserAvatar(uri: Uri, uuid: String? = null) {
        prefs.edit()
            .putString(USER_KEY, uri.toString())
            .putString(USER_UUID_KEY, uuid)
            .apply()
        avatarChangeListener?.invoke()
    }

    fun setAgentAvatar(uri: Uri, uuid: String? = null) {
        prefs.edit()
            .putString(AGENT_KEY, uri.toString())
            .putString(AGENT_UUID_KEY, uuid)
            .apply()
        avatarChangeListener?.invoke()
    }

    fun getUserAvatarUri(): Uri? =
        prefs.getString(USER_KEY, null)?.let { Uri.parse(it) }

    fun getAgentAvatarUri(): Uri? =
        prefs.getString(AGENT_KEY, null)?.let { Uri.parse(it) }

    fun getUserAvatarUuid(): String? =
        prefs.getString(USER_UUID_KEY, null)

    fun getAgentAvatarUuid(): String? =
        prefs.getString(AGENT_UUID_KEY, null)

    fun clearUserAvatar() {
        prefs.edit()
            .remove(USER_KEY)
            .remove(USER_UUID_KEY)
            .apply()
    }

    fun clearAgentAvatar() {
        prefs.edit()
            .remove(AGENT_KEY)
            .remove(AGENT_UUID_KEY)
            .apply()
        avatarChangeListener?.invoke()
    }
    
    fun setAvatarChangeListener(listener: (() -> Unit)?) {
        avatarChangeListener = listener
    }
    
    fun updateUserAvatarUuid(uuid: String?) {
        prefs.edit()
            .putString(USER_UUID_KEY, uuid)
            .apply()
    }
    
    fun updateAgentAvatarUuid(uuid: String?) {
        prefs.edit()
            .putString(AGENT_UUID_KEY, uuid)
            .apply()
    }
}

