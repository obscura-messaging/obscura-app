// swift-tools-version: 6.0

import PackageDescription

// libsignal's Swift code builds from source; its Rust core comes prebuilt as an XCFramework for the
// same release, as libsignal's swift/README.md describes. A mismatch fails to link with an undefined
// `signal_ffi_version_X_Y_Z`. The XCFramework has iOS device and simulator slices only, so the kit
// and its tests build for iOS (`dev.sh` runs the tests on a simulator).
let libsignalVersion = "0.106.2"
let libsignalFfiChecksum = "416ca269870a0bb1e12784dfe96bbd548b585d4aa58f1c12d82b9e19da42a157"

let package = Package(
    name: "ObscuraKit",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "ObscuraKit",
            targets: ["ObscuraKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.25.0"),
        // GRDB 6.29.3 + SQLCipher (CommonCrypto backend), maintained by DuckDuckGo.
        // 2.4.2-1 is their source-code release tag; 3.x jumps to GRDB 7.
        .package(url: "https://github.com/duckduckgo/GRDB.swift.git", exact: "2.4.2-1"),
        .package(url: "https://github.com/signalapp/libsignal", exact: Version(stringLiteral: libsignalVersion)),
    ],
    targets: [
        .binaryTarget(
            name: "LibSignalFfi",
            url: "https://build-artifacts.signal.org/libraries/libsignal-client-ios-build-v\(libsignalVersion).xcframework.zip",
            checksum: libsignalFfiChecksum),
        .target(
            name: "ObscuraKit",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "LibSignalClient", package: "libsignal"),
                "LibSignalFfi",
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]),
        .testTarget(
            name: "ScenarioTests",
            dependencies: ["ObscuraKit"],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]),
        // Pure-logic unit tests — no network, no live server (mirrors Kotlin's
        // :lib:test). This is the fast PR gate.
        .testTarget(
            name: "UnitTests",
            dependencies: [
                "ObscuraKit",
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]),
    ]
)
