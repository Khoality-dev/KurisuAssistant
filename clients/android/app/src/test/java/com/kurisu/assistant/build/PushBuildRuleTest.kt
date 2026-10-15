package com.kurisu.assistant.build

import com.google.common.truth.Truth.assertThat
import org.junit.Test
import java.io.File

/**
 * Push to phones is Firebase Cloud Messaging (#353), and the build must work
 * without Firebase: CI, forks and local builds have no google-services.json.
 * So the google-services plugin is applied only when the file is there, a
 * variant the file does not cover warns instead of failing, and the file can
 * never be committed. The always-on foreground service push replaced is gone.
 */
class PushBuildRuleTest {

    private fun android(path: String): String {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        repeat(6) {
            val candidate = File(dir, path)
            if (candidate.isFile) return candidate.readText()
            val nested = File(dir, "clients/android/$path")
            if (nested.isFile) return nested.readText()
            dir = dir?.parentFile
        }
        error("$path not found")
    }

    @Test
    fun `the google-services plugin is applied only when the file exists, and warns on a missing variant`() {
        val gradle = android("app/build.gradle.kts")
        assertThat(gradle).contains("val googleServicesJson = file(\"google-services.json\")")
        assertThat(gradle).contains("if (googleServicesJson.exists()) {\n    apply(plugin = \"com.google.gms.google-services\")")
        assertThat(gradle).contains("MissingGoogleServicesStrategy.WARN")
        // ...and a variant whose package the file lists no client for is skipped, not failed.
        assertThat(gradle).contains("android_client_info")
        assertThat(gradle).contains("if (name in unlistedTasks) enabled = false")
        assertThat(gradle).doesNotContain("id(\"com.google.gms.google-services\")\n}")
    }

    @Test
    fun `the Firebase file is never committed`() {
        assertThat(android(".gitignore")).contains("/app/google-services.json")
    }

    @Test
    fun `push arrives through Firebase, not a foreground service`() {
        val manifest = android("app/src/main/AndroidManifest.xml")
        assertThat(manifest).contains(".service.KurisuMessagingService")
        assertThat(manifest).contains("com.google.firebase.MESSAGING_EVENT")
        assertThat(manifest).doesNotContain("NotificationService\"")
        assertThat(manifest).doesNotContain("remoteMessaging")
        assertThat(manifest).doesNotContain("RECEIVE_BOOT_COMPLETED")
    }
}
