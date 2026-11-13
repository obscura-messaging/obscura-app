plugins {
    // Same Kotlin as the app and the kit (React Native pins it).
    kotlin("jvm") version "2.2.0"
}

kotlin {
    jvmToolchain(21)
}

val coreDir = layout.projectDirectory.dir("../..")
val generatedDir = layout.buildDirectory.dir("generated/uniffi")
// Host cdylib, built with the same features as the bindgen so one cargo build serves both.
val hostLibrary = coreDir.file("target/release/libobscura_core.so")

val buildHostCore by tasks.registering(Exec::class) {
    description = "Builds the host obscura-core cdylib and the uniffi-bindgen."
    workingDir = coreDir.asFile
    commandLine("cargo", "build", "--release", "--features", "bindgen", "--lib", "--bin", "uniffi-bindgen")
    // Cargo does its own up-to-date checks.
    outputs.upToDateWhen { false }
}

val generateBindings by tasks.registering(Exec::class) {
    description = "Generates the Kotlin bindings from the host library."
    dependsOn(buildHostCore)
    workingDir = coreDir.asFile
    inputs.file(hostLibrary)
    outputs.dir(generatedDir)
    doFirst { generatedDir.get().asFile.deleteRecursively() }
    commandLine(
        "target/release/uniffi-bindgen", "generate",
        "--library", hostLibrary.asFile.path,
        "--language", "kotlin", "--no-format",
        "--out-dir", generatedDir.get().asFile.path,
    )
}

sourceSets.main {
    kotlin.srcDir(generateBindings)
}

dependencies {
    implementation("net.java.dev.jna:jna:5.18.1")
    // The bindings use coroutines for async exports.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter-api")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    dependsOn(buildHostCore)
    systemProperty("uniffi.component.obscura_core.libraryOverride", hostLibrary.asFile.path)
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
