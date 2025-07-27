import java.io.FileInputStream
import java.util.Properties

val secretsFile = rootProject.file("secrets.properties")
val secrets = Properties().apply {
    if (secretsFile.exists()) {
        load(FileInputStream(secretsFile))
    } else {
        // fallback to environment variable, e.g. in CI
        this["API_TOKEN"] = System.getenv("API_TOKEN") ?: ""
    }
}

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.kurisuassistant.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kurisuassistant.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true     // ← explicitly enable generation
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
}
android.buildFeatures.buildConfig = true
dependencies {
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.recyclerview)
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.ucrop)
    implementation(libs.markwon)
    implementation(libs.markwon.linkify)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}