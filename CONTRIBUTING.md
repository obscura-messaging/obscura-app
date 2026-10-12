# Contributing

Never commit to `main`. A PR merges once `JavaScript`, `Android + push sender`
and `iOS Debug Build` pass on a branch that is up to date with `main`.

## Prerequisites

| For | Needs |
| --- | --- |
| All work | [`just`](https://github.com/casey/just), Git, Node 22.11+ ([`.nvmrc`](.nvmrc)) |
| Android | JDK 21, Android SDK 36, NDK `27.1.12297006` |
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
just doctor-android && just android-release   # or: just android-run
just doctor-ios && just ios-build             # simulator
```

For a faster build, use `just android-release arm64-v8a false` (one ABI, no R8)
or `just ios-build arm64`.

- **Firebase.** Android needs `android/app/google-services.json`. When the
  file is missing, the Android recipes copy in a compile-only stub. For real
  push, download the `dev.barrelmaker.obscura` config from Firebase into that
  path. It is gitignored. Never commit it, or any Firebase Admin credential.
- **iOS.** The first build fetches the libsignal commit that `obscura-native`
  pins. It then builds the simulator FFI, the Swift package and the pods, and
  caches them (gitignored). Simulator builds do not exercise APNs, background
  delivery or release signing.
- **Server.** Both apps use `https://obscura.barrelmaker.dev`; there is no
  override. Migrations are not kept before the first public release, so a schema
  change can require clearing app data.

### iOS device build with your own team

The project signs with team `KY4LCG34B8` and App Group
`group.dev.barrelmaker.obscura`. Without that team, override signing on the
command line instead; no tracked files change. Without the App Group, the app
falls back to its private container.

```bash
just ios-build   # once, to prepare dependencies
./obscura-native/swift/scripts/bootstrap-libsignal.sh ios-device
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

`just check` runs Jest, both typechecks, ESLint and
`scripts/check-native-doc-links.sh`. Jest covers the domain, bridge facade and
state logic. It does not cover rendered UI or device behavior.

| CI job | Runs | On |
| --- | --- | --- |
| `JavaScript` | `just check`, `scripts/test-verify-internal-build.py` | PRs, `main` |
| `Android + push sender` | `just android-release arm64-v8a false`, `just push-sender-build` | PRs |
| `iOS Debug Build` | `just ios-build arm64` | PRs |

## Updating `obscura-native`

Kit changes land in `obscura-native` first. After that merges, bump the gitlink
here in its own PR. Then point every `obscura-native/blob/<sha>` doc link at the
new SHA; `just check` enforces this.

```bash
git -C obscura-native fetch origin
git -C obscura-native switch --detach <full-commit-sha>
git -C obscura-native submodule update --init --recursive
git add obscura-native
```
