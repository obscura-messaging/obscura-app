pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Lock repository declarations at the settings level. Any subproject that
// tries to add its own `repositories { ... }` block will fail the build,
// which prevents accidental supply-chain widening (a transitive plugin
// adding a non-vetted maven mirror, etc.). The same Google + MavenCentral
// pair as the project root previously declared.
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "obscura-client-kotlin"

include("lib")
