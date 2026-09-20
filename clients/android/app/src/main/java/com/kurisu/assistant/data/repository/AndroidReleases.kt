package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.GithubRelease

/**
 * Which of the repository's releases are ours.
 *
 * Since #256 a version is one release, `vX.Y.Z`, carrying both clients: the
 * desktop installers, electron-updater's manifests and our APK. We list the
 * releases (not `releases/latest` — that is what the desktop reads, and it
 * would work here too, but the list lets a phone skip a release the desktop
 * took and we did not) and take the newest one that is ours by version.
 *
 * "Ours" is a `vX.Y.Z` release that actually carries an `.apk` — the three
 * `v0.0.x` releases from 2025 predate the clients and carry none — or, from
 * before #256, an `android-vX.Y.Z` one. The alias the release workflow still
 * publishes under that older tag exists for apps that predate this class;
 * once none is installed, the `android-v` branch below and that workflow
 * job go together. Drafts are never releases; pre-release status is ignored,
 * because the alias is deliberately one.
 */
internal object AndroidReleases {
    /** The tag an app from before #256 looked for — kept while the alias is published. */
    const val LEGACY_TAG_PREFIX = "android-v"

    private val RELEASE_TAG = Regex("""^(android-)?v\d+\.\d+\.\d+$""")

    fun isOurs(release: GithubRelease): Boolean =
        !release.draft && RELEASE_TAG.matches(release.tagName) && release.assets.any { it.name.endsWith(".apk") }

    fun newest(releases: List<GithubRelease>): GithubRelease? =
        releases
            .filter(::isOurs)
            // Same version under both tags (the alias) → prefer the unified release.
            .maxWithOrNull(compareBy<GithubRelease, List<Int>>(VERSION_ORDER) { version(it.tagName) }
                .thenBy { if (it.tagName.startsWith(LEGACY_TAG_PREFIX)) 0 else 1 })

    fun isNewer(remoteTag: String, localVersion: String): Boolean =
        VERSION_ORDER.compare(version(remoteTag), version(localVersion)) > 0

    /** "android-v0.3.0", "v0.3.0" and "0.3.0" all read as [0, 3, 0]. */
    internal fun version(tag: String): List<Int> =
        tag.removePrefix(LEGACY_TAG_PREFIX).removePrefix("v").split(".").mapNotNull { it.toIntOrNull() }

    private val VERSION_ORDER = Comparator<List<Int>> { a, b ->
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = a.getOrElse(i) { 0 }.compareTo(b.getOrElse(i) { 0 })
            if (d != 0) return@Comparator d
        }
        0
    }
}
