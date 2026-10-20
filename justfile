set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Install submodules and JavaScript dependencies.
setup:
    git submodule update --init --recursive
    npm ci

# Install JavaScript dependencies from the lockfile.
install:
    npm ci

# Ensure JavaScript dependencies exist without reinstalling on every build.
[private]
ensure-node-modules:
    @if [[ ! -d node_modules/@react-native/gradle-plugin ]]; then echo "Installing JavaScript dependencies (node_modules missing)..."; npm ci; fi

# Verify shared JavaScript prerequisites.
doctor:
    @command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
    @command -v node >/dev/null || { echo "error: Node 22.11+ is required" >&2; exit 1; }
    @command -v npm >/dev/null || { echo "error: npm is required" >&2; exit 1; }
    @node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 11)) { console.error(`error: Node 22.11+ is required; found ${process.versions.node}`); process.exit(1); }'
    @echo "Shared Obscura prerequisites are ready."

# Verify Android prerequisites.
doctor-android: doctor ensure-node-modules
    @./scripts/run-with-android-env.sh ./android/gradlew -p android --version >/dev/null
    @echo "Android prerequisites are ready."

# Verify iOS prerequisites.
doctor-ios: doctor
    @test "$(uname -s)" = "Darwin" || { echo "error: iOS builds require macOS" >&2; exit 1; }
    @command -v xcodebuild >/dev/null || { echo "error: Xcode command-line tools are required" >&2; exit 1; }
    @command -v rustup >/dev/null || { echo "error: rustup is required" >&2; exit 1; }
    @command -v protoc >/dev/null || { echo "error: protoc is required" >&2; exit 1; }
    @command -v pod >/dev/null || { echo "error: CocoaPods 1.17.0 is required" >&2; exit 1; }
    @echo "iOS prerequisites are ready."

# Run Jest tests.
test:
    npm test

# Type-check app and test sources.
typecheck:
    npm run typecheck

# Run ESLint.
lint:
    npm run lint

# Run every JavaScript CI gate.
check: test typecheck lint
    ./scripts/check-native-doc-links.sh

# Create a compile-only Firebase config when no real config exists.
android-config:
    @if [[ ! -f android/app/google-services.json ]]; then cp android/app/google-services.stub.json android/app/google-services.json; echo "Created ignored Firebase stub for compile-only builds."; else echo "Using existing android/app/google-services.json."; fi

# Run the Android app.
android-run: android-config ensure-node-modules
    ./scripts/run-with-android-env.sh npm run android

# Internal release assembler shared by compile-only and distribution builds.
[private]
android-assemble-release architectures minify distribution version_code version_name: android-config ensure-node-modules
    architectures={{quote(architectures)}}; minify={{quote(minify)}}; distribution={{quote(distribution)}}; version_code={{quote(version_code)}}; version_name={{quote(version_name)}}; args=("-PenableProguardInReleaseBuilds=$minify"); [[ -z "$architectures" ]] || args+=("-PreactNativeArchitectures=$architectures"); if [[ "$distribution" == "true" ]]; then [[ "$version_code" =~ ^[1-9][0-9]*$ ]] || { echo "error: distribution version code must be a positive integer" >&2; exit 1; }; [[ -n "$version_name" ]] || { echo "error: distribution version name is required" >&2; exit 1; }; args+=("-PobscuraDistributionBuild=true" "-PobscuraVersionCode=$version_code" "-PobscuraVersionName=$version_name"); fi; ./scripts/run-with-android-env.sh ./android/gradlew -p android :app:assembleRelease --parallel "${args[@]}"

# Assemble a compile-only Android release APK. Pass an architecture list and
# false to skip R8 for a faster build:
# just android-release arm64-v8a false
android-release architectures="" minify="true":
    just android-assemble-release {{quote(architectures)}} {{quote(minify)}} false '' ''

# Assemble a signed, minified universal APK with real Firebase configuration.
# Signing credentials are read from android/keystore.properties or the
# ANDROID_RELEASE_* environment variables.
android-distribution version_code version_name:
    just android-assemble-release '' true true {{quote(version_code)}} {{quote(version_name)}}

# Clean Android build outputs.
android-clean: ensure-node-modules
    rm -rf android/app/.cxx
    ./scripts/run-with-android-env.sh ./android/gradlew -p android clean --parallel

# Prepare all native iOS dependencies.
[private]
ios-prepare libsignal_target="ios-sim": ensure-node-modules
    ./obscura-native/swift/scripts/bootstrap-libsignal.sh {{quote(libsignal_target)}}
    ./obscura-native/swift/dev.sh prepare
    cd ios && pod install

# Build the iOS app for a generic simulator. Pass an architecture for a faster
# compile-only build, for example: just ios-build arm64
ios-build architecture="": ios-prepare
    architecture={{quote(architecture)}}; args=(COMPILER_INDEX_STORE_ENABLE=NO); [[ -z "$architecture" ]] || args+=(ARCHS="$architecture" ONLY_ACTIVE_ARCH=YES); GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO "${args[@]}" build

# Archive the production-bundle-ID device build for App Store Connect/TestFlight.
ios-archive archive_path="ios/build/Obscura.xcarchive" build_number="" version="": (ios-prepare "ios-device")
    build_number={{quote(build_number)}}; version={{quote(version)}}; args=(); [[ -z "$build_number" ]] || args+=(CURRENT_PROJECT_VERSION="$build_number"); [[ -z "$version" ]] || args+=(MARKETING_VERSION="$version"); GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -configuration Release -destination 'generic/platform=iOS' -archivePath {{quote(archive_path)}} "${args[@]}" archive
