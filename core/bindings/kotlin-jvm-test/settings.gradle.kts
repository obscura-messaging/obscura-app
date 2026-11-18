// JVM proof that the UniFFI Kotlin bindings of obscura-core work against the host library.
// Run with the app's wrapper: ./android/gradlew -p core/bindings/kotlin-jvm-test test
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "obscura-core-kotlin-jvm-test"
