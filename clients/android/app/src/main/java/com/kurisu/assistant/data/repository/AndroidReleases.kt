package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.GithubRelease

/**
 * Which of the repository's releases are ours.
 *
 * Both clients publish into Khoality-dev/KurisuAssistant (#229), so
 * `releases/latest` is not ours to read — it is the desktop's, because its
 * electron-updater can read nothing else. We list the releases instead and take
 * the newest `android-v*` one, drafts excluded. Pre-release status is ignored:
 * every Android release is marked one, precisely to stay out of `latest`.
 */
internal object AndroidReleases {
    const val TAG_PREFIX = "android-v"

    fun newest(releases: List<GithubRelease>): GithubRelease? =
        releases
            .filter { !it.draft && it.tagName.startsWith(TAG_PREFIX) }
            .maxWithOrNull(compareBy(VERSION_ORDER) { version(it.tagName) })

    fun isNewer(remoteTag: String, localVersion: String): Boolean =
        VERSION_ORDER.compare(version(remoteTag), version(localVersion)) > 0

    /** "android-v0.3.0", "v0.3.0" and "0.3.0" all read as [0, 3, 0]. */
    internal fun version(tag: String): List<Int> =
        tag.removePrefix(TAG_PREFIX).removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }

    private val VERSION_ORDER = Comparator<List<Int>> { a, b ->
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = a.getOrElse(i) { 0 }.compareTo(b.getOrElse(i) { 0 })
            if (d != 0) return@Comparator d
        }
        0
    }
}
