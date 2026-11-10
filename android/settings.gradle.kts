// The Android app: a thin shell around the same web interface, carried
// inside the APK (docs/adr/0007-installable-apps.md). Build the web first:
//   cd ../web && npm run build && cd ../android && gradle assembleDebug
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "thread-android"
include(":app")
