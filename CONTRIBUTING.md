# Contributing

Never commit to `main`. A PR merges once `JavaScript`, `Android Release Build`
and `iOS Debug Build` pass on a branch that is up to date with `main`.

## Prerequisites

| For | Needs |
| --- | --- |
| All work | [`just`](https://github.com/casey/just), Git, Node 22.11+ ([`.nvmrc`](.nvmrc)) |
| Android | JDK 21, Android SDK 37, NDK `27.1.12297006` |
| iOS | macOS, Xcode, `rustup`, `protoc`, CocoaPods 1.17.0 |

On macOS: `brew install just protobuf`, then
`sudo gem install cocoapods -v 1.17.0 -N`.

Gradle recipes reject any JDK except 21. They find it through `JAVA_HOME`, or
`java_home -v 21` on macOS. The Android SDK comes from `ANDROID_HOME`, or from
`~/Library/Android/sdk` on macOS or `~/Android/Sdk` on Linux. A direct
`android/gradlew` call uses only your shell environment.

## Setup and builds

```bash
git clone --recurse-submodules https://github.com/obscura-messaging/obscura-app.git
cd obscura-app && just setup && just doctor
just doctor-android && just android-apk       # or: just android-run
just doctor-ios && just ios-build             # simulator
```

For a faster build, use `just android-apk arm64-v8a false` (one ABI, no R8)
or `just ios-build arm64`.

- **Firebase.** Android needs `android/app/google-services.json`. When the
  file is missing, the Android recipes copy in a compile-only stub. For real
  push, download the Firebase config (containing `dev.barrelmaker.obscura.dev`
  and `dev.barrelmaker.obscura`) into that path. It is gitignored. Never commit
  it, or any Firebase Admin credential.
- **iOS.** The first build fetches the pinned libsignal commit.
  It then builds the simulator FFI, the Swift package and the pods, and
  caches them (gitignored). Simulator builds do not exercise APNs, background
  delivery or release signing.
- **Environments (`dev` vs `prod`).** Builds default to `dev`
  (`dev.barrelmaker.obscura.dev`, **Obscura Dev**, pointing at
  `https://devscura.barrelmaker.dev`); passing `env=prod` selects production
  (`dev.barrelmaker.obscura`, **Obscura**, pointing at
  `https://obscura.barrelmaker.dev`). Migrations are not kept before the first
  public release, so a schema change can require clearing app data.

### iOS device build with your own team

The project signs with team `KY4LCG34B8` and App Group
`group.dev.barrelmaker.obscura`. Without that team, override signing on the
command line instead; no tracked files change. Without the App Group, the app
falls back to its private container.

```bash
just ios-build   # once, to prepare dependencies
./swift/scripts/bootstrap-libsignal.sh ios-device
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

`just check` runs Jest, both typechecks, and ESLint; `just kotlin-check`
runs protocol conformance and the Kotlin kit unit/coverage suite.

| CI job | Runs | On |
| --- | --- | --- |
| `JavaScript` | `just check`, `scripts/test-verify-release-build.py` | PRs, `main` |
| `Android Release Build` | `just android-apk arm64-v8a false` | PRs |
| `iOS Debug Build` | `just ios-build arm64` | PRs |
