package com.kurisu.assistant.domain.version

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * About says when the app and the backend are different releases (#257); the
 * rules mirror the desktop's `versionParity.test.ts`.
 */
class VersionParityTest {

    @Test
    fun `keeps major minor patch and drops the rest`() {
        assertEquals("0.7.0", VersionParity.releaseCore("0.7.0"))
        assertEquals("0.7.0", VersionParity.releaseCore("v0.7.0"))
        assertEquals("0.7.0", VersionParity.releaseCore("0.7.0-dev-a1b2c3d-dirty"))
        assertEquals("0.7.0", VersionParity.releaseCore("0.7.0+42"))
    }

    @Test
    fun `is null for nothing and for strings with no release in them`() {
        assertNull(VersionParity.releaseCore(null))
        assertNull(VersionParity.releaseCore(""))
        assertNull(VersionParity.releaseCore("?"))
        assertNull(VersionParity.releaseCore("0.7"))
    }

    @Test
    fun `says nothing when both sides are the same release`() {
        assertNull(VersionParity.mismatchSentence("0.7.0", "0.7.0"))
        assertNull(VersionParity.mismatchSentence("0.7.0-dev-abc1234", "v0.7.0"))
    }

    @Test
    fun `names both numbers when they differ`() {
        assertEquals(
            "This app is v0.7.0; the backend is v0.6.0 — update whichever is behind.",
            VersionParity.mismatchSentence("0.7.0", "0.6.0"),
        )
    }

    @Test
    fun `says nothing when either side is unknown`() {
        assertNull(VersionParity.mismatchSentence(null, "0.7.0"))
        assertNull(VersionParity.mismatchSentence("0.7.0", null))
        assertNull(VersionParity.mismatchSentence("0.7.0", "?"))
    }
}
