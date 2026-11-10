import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Keep upload keys outside the generated project and source control. Debug builds
// continue to use Android's debug key; an unset path leaves release builds unsigned.
val signingPropertiesPath = providers.environmentVariable("AIO_ANDROID_KEYSTORE_PROPERTIES").orNull
val signingProperties = signingPropertiesPath?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}

// AIO_ANDROID_DIST=full builds the side-loaded app (docs/EXEC-ENVS.md, "The side-loaded Android app"): its own
// application id beside the Play app, and src/full (adb pairing, the shell helper, apps and screen). Without it
// this is the Play build, with src/play's stand-in, which has none of that.
val fullBuild = providers.environmentVariable("AIO_ANDROID_DIST").orNull == "full"

android {
    compileSdk = 37
    namespace = "ai.clawpage.agent"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = if (fullBuild) "ai.clawpage.agent.full" else "ai.clawpage.agent"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    sourceSets {
        getByName("main").java.srcDir(if (fullBuild) "src/full/java" else "src/play/java")
        if (fullBuild) {
            getByName("main").res.srcDir("src/full/res")
            getByName("debug").manifest.srcFile("src/full/AndroidManifest.xml")
            getByName("release").manifest.srcFile("src/full/AndroidManifest.xml")
            // Only for the emulator tests (another uid knocking on the helper); never in a release build.
            getByName("debug").java.srcDir("src/fullDebug/java")
            getByName("test").java.srcDir("src/fullTest/java")
        }
    }
    if (signingProperties != null) {
        signingConfigs {
            create("release") {
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("password")
                storeFile = file(requireNotNull(signingProperties.getProperty("storeFile")))
                storePassword = signingProperties.getProperty("password")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (signingProperties != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
            if (fullBuild) proguardFile("src/full/full-rules.txt")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // The device link's WebSocket (DeviceTools.kt).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    if (fullBuild) {
        // The app's own adb client (pairing, TLS, shell; Apache-2.0). 2.1.1 is the newest built with a Kotlin this
        // project's compiler reads (2.3). Its SPAKE2 library is GPL-3.0 and stays out: src/full has an Apache-2.0
        // port of BoringSSL's under the same names (com/flyfish233/crypto/spake2/Spake2Context.kt).
        implementation("com.flyfishxu:kadb-android:2.1.1") { exclude(group = "com.github.Flyfish233", module = "spake2-java") }
        implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    }
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
