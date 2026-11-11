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
// adding a non-vetted maven mirror, etc.).
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Signal publishes libsignal releases after 0.86.5 only to its own
        // repository. Only org.signal resolves from it, and org.signal
        // resolves from nowhere else.
        exclusiveContent {
            forRepository { maven("https://build-artifacts.signal.org/libraries/maven/") { name = "signal" } }
            filter { includeGroup("org.signal") }
        }
    }
}

rootProject.name = "obscura-client-kotlin"

include("lib")
