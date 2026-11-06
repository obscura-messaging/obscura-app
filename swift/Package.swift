// swift-tools-version: 6.0

import PackageDescription

// Absolute path to the prebuilt libsignal FFI static lib, derived from this
// Package.swift's location (CWD-independent). The vendored libsignal package
// only adds a `-L` for its OWN test target, so consumers must supply the path.
let packageDir = String(#filePath.dropLast("/Package.swift".count))
let libsignalLibDir = packageDir + "/vendored/libsignal/target/release"

let package = Package(
    name: "ObscuraKit",
    platforms: [
        .macOS(.v13),
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
        // dev.sh copies libsignal's `swift/` package to this uniquely named
        // path; otherwise its inferred identity collides with this directory.
        .package(name: "LibSignalClient", path: "vendored/LibSignalClient"),
    ],
    targets: [
        .target(
            name: "ObscuraKit",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "LibSignalClient", package: "LibSignalClient"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]),
        .testTarget(
            name: "ScenarioTests",
            dependencies: ["ObscuraKit"],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ],
            linkerSettings: [
                .unsafeFlags(["-L", libsignalLibDir]),
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
            ],
            linkerSettings: [
                .unsafeFlags(["-L", libsignalLibDir]),
            ]),
    ]
)
