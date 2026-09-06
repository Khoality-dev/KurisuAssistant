package com.kurisu.assistant.build

import com.google.common.truth.Truth.assertThat
import java.io.File
import org.junit.Test

/**
 * The release build type must never borrow the debug signing key (#100).
 *
 * There is no runtime surface to test here — the rule lives in the build script
 * — so this reads the script, the way the backend's static checks read their own
 * source. It is cheap and it fails the moment someone restores the fallback,
 * which is exactly the regression worth catching: the old behaviour was silent
 * and produced an APK that installed perfectly well.
 */
class ReleaseSigningRuleTest {

    private fun buildScript(): String {
        val candidates = listOf(
            // Gradle runs unit tests with the module directory as the working dir.
            File("build.gradle.kts"),
            File("app/build.gradle.kts"),
            File("clients/android/app/build.gradle.kts"),
        )
        val found = candidates.firstOrNull { it.isFile }
            ?: error(
                "could not find app/build.gradle.kts from ${File("").absolutePath}; " +
                    "tried ${candidates.joinToString { it.path }}"
            )
        return found.readText()
    }

    @Test
    fun `no build type is ever given the debug signing config`() {
        assertThat(buildScript()).doesNotContain("""signingConfigs.getByName("debug")""")
    }

    @Test
    fun `a release variant cannot be packaged without the signing guard`() {
        val script = buildScript()
        assertThat(script).contains("""tasks.register("verifyReleaseSigning")""")
        assertThat(script).contains("dependsOn(verifyReleaseSigning)")
    }

    @Test
    fun `a release build still uses the release key when there is one`() {
        // The other half of the rule: refusing to sign with the debug key is
        // only correct if the real key is still used when it is available.
        assertThat(buildScript()).contains("""signingConfig = signingConfigs.getByName("release")""")
    }

    @Test
    fun `the refusal names every value it needs`() {
        val script = buildScript()
        for (key in listOf(
            "KURISU_KEYSTORE_BASE64",
            "KURISU_KEYSTORE_PASSWORD",
            "KURISU_KEY_ALIAS",
            "KURISU_KEY_PASSWORD",
        )) {
            assertThat(script).contains(key)
        }
    }
}
