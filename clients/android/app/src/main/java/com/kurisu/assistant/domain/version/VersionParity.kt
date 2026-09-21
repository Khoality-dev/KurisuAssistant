package com.kurisu.assistant.domain.version

/**
 * Whether the app and the backend are the same release.
 *
 * One number is meant to cover the backend and both clients (#256), so About
 * can say plainly when they have drifted instead of leaving two strings side by
 * side to compare (#257). Only the release core counts: `v0.7.0`,
 * `0.7.0-dev-a1b2c3d-dirty` and `0.7.0+42` are all the 0.7.0 release, so a dev
 * build against its own backend does not warn about its own stamp. The desktop's
 * `versionParity.ts` makes the same call with the same rules.
 */
object VersionParity {

    private val core = Regex("""^\s*v?(\d+\.\d+\.\d+)""", RegexOption.IGNORE_CASE)

    /** `major.minor.patch` of a version string, or null when it has no such core. */
    fun releaseCore(version: String?): String? {
        if (version.isNullOrEmpty()) return null
        return core.find(version)?.groupValues?.get(1)
    }

    /**
     * The sentence to show when the two are different releases, or null when
     * they agree or when either side is unknown — an unreachable backend is its
     * own message, not a mismatch.
     */
    fun mismatchSentence(appVersion: String?, backendVersion: String?): String? {
        val app = releaseCore(appVersion) ?: return null
        val backend = releaseCore(backendVersion) ?: return null
        if (app == backend) return null
        return "This app is v$app; the backend is v$backend — update whichever is behind."
    }
}
