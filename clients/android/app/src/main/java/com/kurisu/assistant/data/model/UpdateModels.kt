package com.kurisu.assistant.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class GithubRelease(
    @SerialName("tag_name") val tagName: String,
    val name: String? = null,
    val body: String? = null,
    val assets: List<GithubAsset> = emptyList(),
)

@Serializable
data class GithubAsset(
    val name: String,
    @SerialName("browser_download_url") val browserDownloadUrl: String,
    val size: Long = 0,
)

/**
 * Manifest format for dev-flavor auto-update served by AndroidLocalDeployment.
 *
 * The build/deploy step writes this JSON next to the APK at
 *   <server>/apks/kurisu-dev-latest.json
 * and the dev app polls it on launch (see [UpdateRepository]).
 *
 * apkPath is the path component appended to the configured server base URL —
 * either an absolute path like "/apks/foo.apk" or a relative path like
 * "kurisu-assistant-dev-debug-0.2.0-dev.apk" (resolved against /apks/).
 */
@Serializable
data class LocalUpdateManifest(
    @SerialName("version_code") val versionCode: Int,
    @SerialName("version_name") val versionName: String,
    @SerialName("apk_path") val apkPath: String,
    val name: String? = null,
    val body: String? = null,
)
