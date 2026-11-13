# Contributing

Never commit to `main`. A PR merges once `Gate` passes on a branch that is up to
date with `main`.

## Prerequisites

| For | Needs |
| --- | --- |
| All work | [`just`](https://github.com/casey/just), Git, Node 22.13+ ([`.nvmrc`](.nvmrc)) |
| Android | JDK 21, Android SDK 37, NDK `27.1.12297006` |
| iOS | macOS, Xcode ([`.xcode-version`](.xcode-version)), `protoc`, CocoaPods 1.17.0 |

On macOS: `brew install just protobuf`, then
`sudo gem install cocoapods -v 1.17.0 -N`.

Gradle starts on any JDK 17 or newer, then runs the build on JDK 21, which it
finds among your installed JDKs (`gradle/gradle-daemon-jvm.properties` in
`android/` and `kotlin/`). The Android SDK comes from `ANDROID_HOME` or from
`sdk.dir` in `android/local.properties`, which Android Studio writes;
`just doctor-android` says which is missing.

## Setup and builds

```bash
git clone --recurse-submodules https://github.com/obscura-messaging/obscura-app.git
cd obscura-app && just setup && just doctor
just doctor-android && just android-build       # or: just android-run
just doctor-ios && just ios-build             # simulator
```

For a faster build, use `just android-build arm64-v8a false` (one ABI, no R8)
or `just ios-build arm64`.

- **Firebase.** Android needs `android/app/google-services.json`. When the
  file is missing, the Android recipes copy in a compile-only stub. For real
  push, download the Firebase config (containing `dev.barrelmaker.obscura.dev`
  and `dev.barrelmaker.obscura`) into that path. It is gitignored. Never commit
  it, or any Firebase Admin credential.
- **iOS.** The first build resolves the Swift package, including libsignal and
  its prebuilt Rust core (an XCFramework from Signal, pinned with its checksum
  in `swift/Package.swift`), then builds the pods. No Rust toolchain is needed.
  The XCFramework has iOS slices only, so the kit's tests run on an iOS
  simulator. Simulator builds do not exercise APNs, background delivery or
  release signing.
- **Swift protobuf bindings** are generated, not committed: `just swift-proto`
  builds `protoc-gen-swift` at the SwiftProtobuf version both `Package.resolved`
  files pin and writes `swift/Sources/ObscuraKit/Proto`. Every `swift-*` and
  `ios-*` recipe runs it first, so a fresh clone opened straight in Xcode
  does not compile until one of them has run.
- **Environments (`dev` vs `prod`).** Builds default to `dev`
  (`dev.barrelmaker.obscura.dev`, **Obscura Dev**, pointing at
  `https://devscura.barrelmaker.dev`); passing `env=prod` selects production
  (`dev.barrelmaker.obscura`, **Obscura**, pointing at
  `https://obscura.barrelmaker.dev`). Each is a separate app, so both can be
  installed side by side. Android declares them as the `dev` and `prod`
  product flavors in `android/app/build.gradle`; iOS as `ios/Config/Dev.xcconfig`
  (the project default) and `Prod.xcconfig`, with matching export options.
  `src/native/__tests__/environments.test.ts` keeps the platforms in agreement.
  Migrations are not kept before the first public release, so a schema change
  can require clearing app data.

### iOS device build with your own team

The project signs with team `KY4LCG34B8` and App Group
`group.dev.barrelmaker.obscura`. Without that team, override signing on the
command line instead; no tracked files change. Without the App Group, the app
falls back to its private container.

```bash
just ios-build   # once, to prepare dependencies
cd ios && mkdir -p build
printf '<plist version="1.0"><dict/></plist>' > build/Personal.entitlements
xcodebuild -workspace Obscura.xcworkspace -scheme Obscura \
  -destination 'generic/platform=iOS' -configuration Release \
  -allowProvisioningUpdates -derivedDataPath build/personal \
  DEVELOPMENT_TEAM=<TEAM_ID> PRODUCT_BUNDLE_IDENTIFIER=<your.bundle.id> \
  CODE_SIGN_ENTITLEMENTS=build/Personal.entitlements build
xcrun devicectl device install app --device <DEVICE_ID> \
  build/personal/Build/Products/Release-iphoneos/Obscura.app
```

## Checks

`just check` runs Jest, both typechecks, ESLint, and a Prettier check (`just format` fixes it); `just release-script-test` tests
`scripts/verify-release-build.sh`;
`just kotlin-check` runs protocol conformance and the Kotlin kit unit/coverage suite;
`just swift-unit` runs the Swift kit unit and coverage suite.

| CI job | Runs | On |
| --- | --- | --- |
| `JavaScript` | `just check`, `just release-script-test`, `just bundle` | PRs, `main` |
| `Kotlin` | `just protocol-lint`, `just kotlin-check`, `just server-up`, `just kotlin-integration` | Kotlin PRs, `main` |
| `Swift` | `just swift-unit`, `just server-up`, `just swift-integration` | Swift PRs, `main` |
| `Android` | `just android-build arm64-v8a false` | Android PRs |
| `iOS` | `just ios-build arm64` | iOS PRs |

A PR runs a native job only when the job's inputs change: its platform
directory, `server-proto/`, `client-protocol/`, the `justfile`, its workflow, or (for app
builds) the JavaScript toolchain files. A change under `src/` alone runs only
`JavaScript`, which typechecks the code the native builds would bundle. Pushes
to `main` run every job, because a release needs a fully green `main` commit.
The workflow ends in `Gate`, which fails if any job failed or was cancelled,
so branch protection needs only that one check. Every job has a timeout set
well above its cold-cache duration, so a hung macOS job cannot run for the
6-hour default.

## Integration tests

The kit integration suites need a running `obscura-server`.
`just server-up` builds the server at its latest commit (or `just server-up
<ref>`), starts Postgres, Valkey and MinIO, and serves the API on
`http://localhost:3000`. CI uses the same script. `just server-down` stops
everything and deletes the data.

```bash
just server-up
just kotlin-integration      # or: just swift-integration
just server-down
```

Building the server needs `cargo` and `protoc`. By default the services come
from the server's `docker-compose.yml`. Without Docker, set
`OBSCURA_SERVER_SERVICES=native` and install `postgresql@18`, `valkey` and
`minio`. If you already run the services, `OBSCURA_SERVER_SERVICES=external`
starts only the server. To test against your own server checkout, set
`OBSCURA_SERVER_SRC=../obscura-server`.
