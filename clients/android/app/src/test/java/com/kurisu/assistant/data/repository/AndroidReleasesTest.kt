package com.kurisu.assistant.data.repository

import com.kurisu.assistant.data.model.GithubRelease
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository's release list holds both clients' releases (#229); the
 * Android updater must find its own in it and never mistake a desktop release
 * — or `releases/latest`, which is the desktop's — for an update.
 */
class AndroidReleasesTest {

    private fun release(tag: String, draft: Boolean = false, prerelease: Boolean = true) =
        GithubRelease(tagName = tag, draft = draft, prerelease = prerelease)

    @Test
    fun `takes the newest android release and ignores the desktop's`() {
        val releases = listOf(
            release("desktop-v0.9.0", prerelease = false),
            release("android-v0.3.0"),
            release("android-v0.3.1"),
            release("desktop-v0.4.0", prerelease = false),
            release("android-v0.2.0"),
        )
        assertEquals("android-v0.3.1", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `order in the list does not matter`() {
        val releases = listOf(release("android-v0.10.0"), release("android-v0.9.0"), release("android-v1.0.0"))
        assertEquals("android-v1.0.0", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `a draft is not a release`() {
        val releases = listOf(release("android-v0.4.0", draft = true), release("android-v0.3.0"))
        assertEquals("android-v0.3.0", AndroidReleases.newest(releases)?.tagName)
    }

    @Test
    fun `nothing of ours means no update`() {
        assertNull(AndroidReleases.newest(listOf(release("desktop-v0.4.0", prerelease = false))))
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
        assertTrue(AndroidReleases.isNewer("android-v0.3.0", "0.2.0"))
        assertTrue(AndroidReleases.isNewer("android-v0.10.0", "0.9.0"))
        assertTrue(AndroidReleases.isNewer("android-v1.0", "0.9.9"))
        assertFalse(AndroidReleases.isNewer("android-v0.3.0", "0.3.0"))
        assertFalse(AndroidReleases.isNewer("android-v0.3.0", "0.3.0.1"))
        assertFalse(AndroidReleases.isNewer("android-v0.2.9", "0.3.0"))
    }
}
