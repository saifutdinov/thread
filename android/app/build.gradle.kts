import org.gradle.api.file.FileSystemOperations
import javax.inject.Inject

plugins {
    id("com.android.application")
}

// FCM needs the owner's Firebase file (git-ignored, written from a secret in
// CI). Without it the app builds and works, only without pushes.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

// The server this build talks to, and the app's id (its Firebase app's
// package): each server owner sets theirs (docs/apps.md).
val origin = providers.gradleProperty("threadOrigin").getOrElse("https://chat.example.org")
val appId = providers.gradleProperty("threadAppId").getOrElse("io.github.saifutdinov.thread")
// Release signing comes from CI secrets; a local build is signed for debugging.
val keystore = providers.environmentVariable("THREAD_KEYSTORE").orNull

android {
    namespace = "io.github.saifutdinov.thread"
    compileSdk = 37

    defaultConfig {
        applicationId = appId
        minSdk = 29
        targetSdk = 36
        versionCode = providers.gradleProperty("versionCode").getOrElse("1").toInt()
        versionName = providers.gradleProperty("versionName").getOrElse("dev")
        buildConfigField("String", "ORIGIN", "\"$origin\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.environmentVariable("THREAD_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("THREAD_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("THREAD_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// The web build (../web/dist) becomes the app's assets under www/. The
// .br copies are for the server's HTTP; the APK compresses on its own.
abstract class WebAssets : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val dist: DirectoryProperty

    @get:OutputDirectory
    abstract val out: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(dist) { exclude("**/*.br") }
            into(out.dir("www"))
        }
    }
}

val webAssets = tasks.register<WebAssets>("webAssets") {
    dist.set(layout.projectDirectory.dir("../../web/dist"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(webAssets, WebAssets::out)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
    // Firebase brings an old Fragment in; activity results need 1.3+ (release lint).
    implementation("androidx.fragment:fragment:1.9.1")
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
}
