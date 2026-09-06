import java.io.File
import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("com.google.dagger.hilt.android")
}

// Load release signing values from <repo-root>/.env (gitignored). See .env.template.
// A missing or blank value is NOT substituted: a release build without them fails in
// `verifyReleaseSigning` below. It used to fall back to the debug key that ships in every
// Android SDK install, which still produced an installable APK — one that cannot be shown
// to come from this project and that no real release can ever upgrade (#100).
//
// Two ways to provide the keystore (matches the GitHub Actions release workflow):
//   1. KURISU_KEYSTORE_BASE64  — the .jks file base64-encoded, inline in .env (preferred)
//   2. KURISU_KEYSTORE         — path to a .jks file on disk (legacy, still supported)
val envFile = rootProject.file(".env")
val envProps = Properties().apply {
    if (envFile.exists()) envFile.inputStream().use { load(it) }
}
fun env(key: String): String? = envProps.getProperty(key)?.takeIf { it.isNotBlank() }
val releaseKeystoreBase64 = env("KURISU_KEYSTORE_BASE64")
val releaseKeystorePath = env("KURISU_KEYSTORE")
val releaseKeystorePassword = env("KURISU_KEYSTORE_PASSWORD")
val releaseKeyAlias = env("KURISU_KEY_ALIAS")
val releaseKeyPassword = env("KURISU_KEY_PASSWORD")

// Resolve the keystore file. Base64 wins if both are set — same precedence the
// GitHub workflow uses, so local and CI behave identically.
val resolvedKeystoreFile: File? = when {
    releaseKeystoreBase64 != null -> {
        val out = layout.buildDirectory.file("keystore/release.jks").get().asFile
        out.parentFile.mkdirs()
        // Strip whitespace/newlines so multi-line .env values still decode.
        val cleaned = releaseKeystoreBase64.replace("\\s".toRegex(), "")
        out.writeBytes(Base64.getDecoder().decode(cleaned))
        out
    }
    releaseKeystorePath != null -> rootProject.file(releaseKeystorePath)
    else -> null
}
val hasReleaseSigning = resolvedKeystoreFile != null &&
    releaseKeystorePassword != null &&
    releaseKeyAlias != null &&
    releaseKeyPassword != null

// Git commit short hash + dirty marker — stamped into the dev flavor's versionName
// so every install is traceable to a specific tree state.
fun gitShortHash(): String = try {
    ProcessBuilder("git", "rev-parse", "--short", "HEAD")
        .directory(rootDir)
        .redirectErrorStream(true)
        .start()
        .inputStream.bufferedReader().readText().trim()
        .takeIf { it.isNotEmpty() } ?: "unknown"
} catch (e: Exception) { "unknown" }

fun gitIsDirty(): Boolean = try {
    ProcessBuilder("git", "status", "--porcelain")
        .directory(rootDir)
        .redirectErrorStream(true)
        .start()
        .inputStream.bufferedReader().readText().isNotBlank()
} catch (e: Exception) { false }

android {
    namespace = "com.kurisu.assistant"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kurisu.assistant"
        minSdk = 26
        targetSdk = 35
        versionCode = 11
        versionName = "0.3.0"
        // Wire-protocol integer — must equal backend `WIRE_PROTOCOL` in
        // KurisuAssistant/kurisuassistant/version.py. Bump on any breaking
        // change to REST/WebSocket payloads, headers, or auth flow. Sent on
        // every request via WireProtocolInterceptor and checked once on
        // startup against `GET /version`.
        buildConfigField("int", "WIRE_PROTOCOL", "5")
        // Without this AGP falls back to the pre-AndroidX
        // android.test.InstrumentationTestRunner, which crashes on start —
        // the androidTest suite had never actually run (#126).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // One process and a wiped data directory per test: the voice service and
        // the per-persona conversation cache otherwise leak from one full-app
        // test into the next (see e2e/MockBackendChatTest).
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = resolvedKeystoreFile!!
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Only ever this project's own key. With none configured the build type
            // carries no signing config at all and `verifyReleaseSigning` stops the
            // build before it packages anything; the debug config stays where it
            // belongs, on debug builds (#100).
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // Two install-side-by-side variants:
    //   prod → com.kurisu.assistant       (matches GitHub Releases — auto-update works)
    //   dev  → com.kurisu.assistant.dev   (debug builds, app_name "Kurisu Dev")
    flavorDimensions += "channel"
    productFlavors {
        create("prod") {
            dimension = "channel"
            // Prod uses GitHub Releases for auto-update — local URL not needed.
            buildConfigField("String", "DEV_UPDATE_BASE_URL", "\"\"")
            // The instrumented suite is a dev-flavour affair; prod carries no test URL.
            buildConfigField("String", "MOCK_BACKEND_URL", "\"\"")
        }
        create("dev") {
            dimension = "channel"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev-${gitShortHash()}${if (gitIsDirty()) "-dirty" else ""}"
            // Dev flavor polls the LAN APK server for new dev builds. Read from
            // .env (KURISU_DEV_UPDATE_URL) so the value can change per dev
            // machine without touching source. Empty value disables the check.
            val devUpdateUrl = env("KURISU_DEV_UPDATE_URL") ?: ""
            buildConfigField("String", "DEV_UPDATE_BASE_URL", "\"$devUpdateUrl\"")
            // Where the instrumented tests (androidTest/) expect the standalone
            // mock backend — `npm run mock:backend -- --host 0.0.0.0` in
            // clients/desktop. 10.0.2.2 is the emulator's route to the host;
            // override per run with -PmockBackendUrl=http://... (#126).
            val mockBackendUrl = (project.findProperty("mockBackendUrl") as String?)
                ?: "http://10.0.2.2:15597"
            buildConfigField("String", "MOCK_BACKEND_URL", "\"$mockBackendUrl\"")
        }
    }

    // mockk-android pulls JUnit 5 jars whose META-INF licence files collide
    // when the androidTest APK is packaged; without this the instrumented
    // suite cannot even build.
    packaging {
        resources.excludes += setOf("META-INF/LICENSE.md", "META-INF/LICENSE-notice.md")
    }

    // Tag the APK filename with flavor + buildType + version so files dropped
    // into AndroidLocalDeployment/apks/ are self-describing.
    applicationVariants.all {
        val variant = this
        outputs.all {
            val output = this as com.android.build.gradle.internal.api.BaseVariantOutputImpl
            output.outputFileName =
                "kurisu-assistant-${variant.flavorName}-${variant.buildType.name}-${variant.versionName}.apk"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }
}

// ── Release signing is not optional ──────────────────────────────────────────
//
// A release build used to succeed without any signing material by borrowing the
// debug key that ships in every Android SDK install. The APK installed fine, so
// nothing said that it could not be shown to come from this project, or that —
// since signing identity decides upgrade eligibility — nobody who installed it
// could ever be updated by a properly signed release (#100).
//
// The check runs when a release variant is actually built, not while Gradle
// configures the project, so `assembleDevDebug`, `testDevDebugUnitTest` and an
// IDE sync still work on a machine with no signing material at all. Unit and
// instrumented test variants are exempt for the same reason: they are not
// something anyone installs.
val missingSigningValues: List<String> = buildList {
    if (resolvedKeystoreFile == null) add("KURISU_KEYSTORE_BASE64 (or KURISU_KEYSTORE)")
    if (releaseKeystorePassword == null) add("KURISU_KEYSTORE_PASSWORD")
    if (releaseKeyAlias == null) add("KURISU_KEY_ALIAS")
    if (releaseKeyPassword == null) add("KURISU_KEY_PASSWORD")
}

val verifyReleaseSigning = tasks.register("verifyReleaseSigning") {
    group = "verification"
    description = "Refuses to build a release variant without this project's signing key."
    doFirst {
        if (!hasReleaseSigning) {
            throw GradleException(
                buildString {
                    appendLine("Cannot build a release variant: the signing material is missing.")
                    appendLine()
                    appendLine("Missing: ${missingSigningValues.joinToString(", ")}")
                    appendLine()
                    appendLine("A local build reads these from clients/android/.env, which is")
                    appendLine("gitignored; the environment template lists the names. CI reads")
                    appendLine("repository secrets of the same names, which the release workflow")
                    appendLine("(.github/workflows/android-release.yml) writes into that file")
                    appendLine("before it builds.")
                    appendLine()
                    appendLine("This used to fall back to the debug key that ships in every")
                    appendLine("Android SDK install. That APK cannot be shown to come from this")
                    appendLine("project, and no properly signed release can ever upgrade it, so")
                    appendLine("it is refused rather than produced quietly (#100).")
                    appendLine()
                    append("For an installable build without the release key, build a debug ")
                    append("variant instead: ./gradlew assembleProdDebug")
                }
            )
        }
    }
}

// Every task that packages a release variant, for either flavour. `pre*Build` is
// included so the refusal arrives in a second rather than after a full compile.
tasks.matching { task ->
    val name = task.name
    name.contains("Release") &&
        !name.contains("UnitTest") &&
        !name.contains("AndroidTest") &&
        (
            name.startsWith("package") ||
                name.startsWith("bundle") ||
                (name.startsWith("pre") && name.endsWith("Build"))
            )
}.configureEach {
    dependsOn(verifyReleaseSigning)
}

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Core
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")

    // Lifecycle + ViewModel
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Hilt
    implementation("com.google.dagger:hilt-android:2.51.1")
    ksp("com.google.dagger:hilt-android-compiler:2.51.1")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Security (EncryptedSharedPreferences)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Kotlin Serialization + Retrofit converter
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter:1.0.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // CameraX
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")

    // Media3 (ExoPlayer)
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")

    // ONNX Runtime (Silero VAD)
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.19.2")

    // ML Kit Barcode Scanning (login QR). Bundled flavour — no Google Play
    // Services dependency, works on emulators and degoogled devices.
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // Image loading
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Markdown rendering
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")

    // ---- Unit tests (JVM / Robolectric) ----
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("io.mockk:mockk:1.13.12")
    testImplementation("app.cash.turbine:turbine:1.1.0")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("com.google.truth:truth:1.4.4")

    // ---- Instrumented / E2E tests (androidTest) ----
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test:runner:1.6.1")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.06.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("io.mockk:mockk-android:1.13.12")
    androidTestUtil("androidx.test:orchestrator:1.5.0")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
