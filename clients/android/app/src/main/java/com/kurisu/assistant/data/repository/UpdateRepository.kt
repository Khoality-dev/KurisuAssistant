package com.kurisu.assistant.data.repository

import android.content.Context
import com.kurisu.assistant.BuildConfig
import com.kurisu.assistant.data.model.GithubAsset
import com.kurisu.assistant.data.model.GithubRelease
import com.kurisu.assistant.data.model.LocalUpdateManifest
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
        private const val GITHUB_RELEASES_URL =
            "https://api.github.com/repos/Khoality-dev/KurisuAssistant-Client-Android/releases/latest"
        private const val DEV_MANIFEST_PATH = "/apks/kurisu-dev-latest.json"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Returns a release object if a newer build is available, else null.
     * Dispatches by build flavor:
     *   - prod → GitHub Releases (the public ship channel)
     *   - dev  → AndroidLocalDeployment manifest on the LAN
     * The dev path synthesizes a [GithubRelease] so the rest of the update
     * pipeline (HomeViewModel, UpdateDialog, downloadApk) doesn't need to care.
     */
    suspend fun checkForUpdate(): GithubRelease? = when (BuildConfig.FLAVOR) {
        "dev" -> checkLocalDevUpdate()
        else -> checkGithubUpdate()
    }

    private suspend fun checkGithubUpdate(): GithubRelease? = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(GITHUB_RELEASES_URL)
            .header("Accept", "application/vnd.github.v3+json")
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) return@withContext null

        val body = response.body?.string() ?: return@withContext null
        val release = json.decodeFromString<GithubRelease>(body)

        if (isNewer(release.tagName, BuildConfig.VERSION_NAME)) release else null
    }

    private suspend fun checkLocalDevUpdate(): GithubRelease? = withContext(Dispatchers.IO) {
        val baseUrl = BuildConfig.DEV_UPDATE_BASE_URL.trimEnd('/')
        if (baseUrl.isEmpty()) return@withContext null

        val request = Request.Builder().url(baseUrl + DEV_MANIFEST_PATH).build()
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) return@withContext null

        val body = response.body?.string() ?: return@withContext null
        val manifest = json.decodeFromString<LocalUpdateManifest>(body)

        if (manifest.versionCode <= BuildConfig.VERSION_CODE) return@withContext null

        val apkUrl = resolveApkUrl(baseUrl, manifest.apkPath)
        GithubRelease(
            tagName = manifest.versionName,
            name = manifest.name ?: "Dev build ${manifest.versionName}",
            body = manifest.body,
            assets = listOf(
                GithubAsset(
                    name = manifest.apkPath.substringAfterLast('/'),
                    browserDownloadUrl = apkUrl,
                ),
            ),
        )
    }

    private fun resolveApkUrl(baseUrl: String, apkPath: String): String = when {
        apkPath.startsWith("http://") || apkPath.startsWith("https://") -> apkPath
        apkPath.startsWith("/") -> baseUrl + apkPath
        else -> "$baseUrl/apks/$apkPath"
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
