package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.GithubAsset
import com.kurisu.assistant.data.model.GithubRelease
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One release per version since #256: the repository's list holds the unified
 * `vX.Y.Z` releases (both clients), the older per-client ones, the transition
 * alias `android-vX.Y.Z`, and three `v0.0.x` releases from before either
 * client existed. The updater must pick its own by version and never mistake a
 * release without an APK for an update.
 */
class AndroidReleasesTest {

    private val apk = GithubAsset(name = "kurisu-assistant-prod-release-0.7.0.apk", browserDownloadUrl = "https://x/app.apk")
    private val installer = GithubAsset(name = "KurisuAssistant-Setup-0.7.0.exe", browserDownloadUrl = "https://x/setup.exe")

    private fun release(
        tag: String,
        draft: Boolean = false,
        prerelease: Boolean = false,
        assets: List<GithubAsset> = listOf(apk, installer),
    ) = GithubRelease(tagName = tag, draft = draft, prerelease = prerelease, assets = assets)

    @Test
    fun `takes the newest unified release by version`() {
        val releases = listOf(
            release("v0.7.0"),
            release("v0.7.1"),
            release("desktop-v0.4.0", assets = listOf(installer)),
            release("android-v0.3.0", prerelease = true, assets = listOf(apk)),
        )
        assertEquals("v0.7.1", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `an older android-v release still counts during the transition`() {
        val releases = listOf(
            release("android-v0.3.1", prerelease = true, assets = listOf(apk)),
            release("android-v0.3.0", prerelease = true, assets = listOf(apk)),
            release("desktop-v0.4.0", assets = listOf(installer)),
        )
        assertEquals("android-v0.3.1", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `the alias and the unified release of one version resolve to the unified one`() {
        val releases = listOf(
            release("android-v0.7.0", prerelease = true, assets = listOf(apk)),
            release("v0.7.0"),
        )
        assertEquals("v0.7.0", AndroidReleases.newest(releases)?.tagName)
        assertEquals("v0.7.0", AndroidReleases.newest(releases.reversed())?.tagName)
    }

    @Test
    fun `a release without an apk is not ours, whatever its tag`() {
        val releases = listOf(
            release("v0.9.0", assets = listOf(installer)),   // a desktop-only slip
            release("v0.0.3", assets = emptyList()),          // 2025, before the clients
            release("v0.7.0"),
        )
        assertEquals("v0.7.0", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `order in the list does not matter`() {
        val releases = listOf(release("v0.10.0"), release("v0.9.0"), release("v1.0.0"))
        assertEquals("v1.0.0", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `a draft is not a release`() {
        val releases = listOf(release("v0.8.0", draft = true), release("v0.7.0"))
        assertEquals("v0.7.0", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `only a full X Y Z tag is a release`() {
        assertFalse(AndroidReleases.isOurs(release("v0.7")))
        assertFalse(AndroidReleases.isOurs(release("v0.7.0-rc1")))
        assertFalse(AndroidReleases.isOurs(release("backend-v0.6.0")))
        assertFalse(AndroidReleases.isOurs(release("desktop-v0.4.0")))
        assertTrue(AndroidReleases.isOurs(release("v0.7.0")))
        assertTrue(AndroidReleases.isOurs(release("android-v0.3.0", assets = listOf(apk))))
    }

    @Test
    fun `nothing of ours means no update`() {
        assertNull(AndroidReleases.newest(listOf(release("desktop-v0.4.0", assets = listOf(installer)))))
        assertNull(AndroidReleases.newest(emptyList()))
    }

    @Test
    fun `the tag prefix does not count as a version`() {
        assertEquals(listOf(0, 3, 0), AndroidReleases.version("android-v0.3.0"))
        assertEquals(listOf(0, 3, 0), AndroidReleases.version("v0.3.0"))
        assertEquals(listOf(0, 3, 0), AndroidReleases.version("0.3.0"))
    }

    @Test
    fun `newer means strictly greater, numerically, per component`() {
        assertTrue(AndroidReleases.isNewer("v0.7.0", "0.3.0"))
        assertTrue(AndroidReleases.isNewer("android-v0.3.0", "0.2.0"))
        assertTrue(AndroidReleases.isNewer("v0.10.0", "0.9.0"))
        assertTrue(AndroidReleases.isNewer("v1.0", "0.9.9"))
        assertFalse(AndroidReleases.isNewer("v0.3.0", "0.3.0"))
        assertFalse(AndroidReleases.isNewer("v0.3.0", "0.3.0.1"))
        assertFalse(AndroidReleases.isNewer("v0.2.9", "0.3.0"))
    }
}
