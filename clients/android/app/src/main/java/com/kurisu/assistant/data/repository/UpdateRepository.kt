package com.kurisu.assistant.data.repository

import android.content.Context
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.GithubRelease
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class UpdateRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val json: Json,
) {
    companion object {
        private const val RELEASES_URL =
            "https://api.github.com/repos/Khoality-dev/KurisuAssistant-Client-Android/releases/latest"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun checkForUpdate(): GithubRelease? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github.v3+json")
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) return@withContext null

        val body = response.body?.string() ?: return@withContext null
        val release = json.decodeFromString<GithubRelease>(body)

        if (isNewer(release.tagName, BuildConfig.VERSION_NAME)) release else null
    }

    suspend fun downloadApk(url: String, onProgress: (Float) -> Unit): File =
        withContext(Dispatchers.IO) {
            val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
            val file = File(updatesDir, "update.apk")
            if (file.exists()) file.delete()

            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            val responseBody = response.body ?: error("Empty response body")
            val contentLength = responseBody.contentLength()

            responseBody.byteStream().use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(8192)
                    var bytesRead: Long = 0
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        bytesRead += read
                        if (contentLength > 0) {
                            onProgress(bytesRead.toFloat() / contentLength)
                        }
                    }
                }
            }

            file
        }

    internal fun isNewer(remoteTag: String, localVersion: String): Boolean {
        val remote = remoteTag.removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }
        val local = localVersion.removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }

        for (i in 0 until maxOf(remote.size, local.size)) {
            val r = remote.getOrElse(i) { 0 }
            val l = local.getOrElse(i) { 0 }
            if (r > l) return true
            if (r < l) return false
        }
        return false
    }
}
