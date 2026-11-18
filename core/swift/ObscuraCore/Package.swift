// swift-tools-version: 5.9

import PackageDescription

// Swift face of the Rust core. `core/scripts/build-xcframework.sh` produces both the binary
// target and Sources/ObscuraCore/obscura_core.swift (UniFFI-generated), so run it first.
// The XCFramework has iOS device and simulator slices only; test on a simulator.
// Swift 5 language mode: the UniFFI-generated file is not written for Swift 6 strict concurrency.
let package = Package(
    name: "ObscuraCore",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .library(name: "ObscuraCore", targets: ["ObscuraCore"])
    ],
    targets: [
        .binaryTarget(name: "ObscuraCoreFFI", path: "ObscuraCoreFFI.xcframework"),
        .target(
            name: "ObscuraCore",
            dependencies: ["ObscuraCoreFFI"],
            // SQLCipher's CommonCrypto build calls into these; harmless with the OpenSSL build.
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("CoreFoundation"),
            ]),
        .testTarget(
            name: "ObscuraCoreTests",
            dependencies: ["ObscuraCore"]),
    ]
)
