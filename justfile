set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Install submodules and JavaScript dependencies.
setup: install
    git submodule update --init --recursive

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
    @command -v node >/dev/null || { echo "error: Node 22.13+ is required" >&2; exit 1; }
    @command -v npm >/dev/null || { echo "error: npm is required" >&2; exit 1; }
    @node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error(`error: Node 22.13+ is required; found ${process.versions.node}`); process.exit(1); }'
    @echo "Shared Obscura prerequisites are ready."

# Verify Android prerequisites. Gradle picks JDK 21 itself
# (gradle/gradle-daemon-jvm.properties); the SDK comes from ANDROID_HOME or
# sdk.dir in android/local.properties, which Android Studio writes.
doctor-android: doctor ensure-node-modules
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -z "${ANDROID_HOME:-}" ]] && ! grep -qs '^sdk.dir=' android/local.properties; then
        echo "error: set ANDROID_HOME, or sdk.dir in android/local.properties, to your Android SDK" >&2
        for sdk in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
            if [[ -d "$sdk" ]]; then
                echo "  found $sdk: echo 'sdk.dir=$sdk' > android/local.properties" >&2
            fi
        done
        exit 1
    fi
    ./android/gradlew -p android --version >/dev/null
    echo "Android prerequisites are ready."

# Verify iOS prerequisites.
doctor-ios: doctor
    @test "$(uname -s)" = "Darwin" || { echo "error: iOS builds require macOS" >&2; exit 1; }
    @command -v xcodebuild >/dev/null || { echo "error: Xcode command-line tools are required" >&2; exit 1; }
    @command -v protoc >/dev/null || { echo "error: protoc is required (brew install protobuf)" >&2; exit 1; }
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

# Test the release verification script.
release-script-test:
    python3 scripts/test-verify-release-build.py -q

# Bundle the JavaScript for Android and iOS the way a release build does.
bundle: ensure-node-modules
    #!/usr/bin/env bash
    set -euo pipefail
    out="$(mktemp -d)"
    trap 'rm -rf "$out"' EXIT
    for platform in android ios; do
        npx react-native bundle --platform "$platform" --dev false --entry-file index.js \
            --bundle-output "$out/$platform.bundle" --assets-dest "$out/$platform-assets"
    done

# Lint the client-to-client protocol.
protocol-lint:
    buf lint protocol

# Validate protocol conformance fixtures.
protocol-vectors:
    python3 protocol/conformance/validate.py

# Run protocol conformance, then the Kotlin unit tests with coverage reports
# and thresholds, in one Gradle process.
kotlin-check: protocol-vectors
    cd kotlin && ./gradlew :lib:test :lib:koverHtmlReport :lib:koverXmlReport :lib:koverVerify

# Build and start a local obscura-server with Postgres, Valkey and MinIO
# (ref: server git ref, default its HEAD). See scripts/local-server.sh for
# OBSCURA_SERVER_SRC and OBSCURA_SERVER_SERVICES.
server-up ref="":
    ./scripts/local-server.sh up {{quote(ref)}}

# Stop the local obscura-server and delete its data.
server-down:
    ./scripts/local-server.sh down

# Report whether the local obscura-server is running.
server-status:
    ./scripts/local-server.sh status

# Print the end of the local obscura-server log.
server-logs lines="200":
    ./scripts/local-server.sh logs {{quote(lines)}}

# Run Kotlin server-dependent tests against an explicit local endpoint.
kotlin-integration api="http://localhost:3000":
    @curl -fsS "{{ api }}/openapi.yaml" >/dev/null || { echo "error: no Obscura server at {{ api }}" >&2; exit 1; }
    cd kotlin && OBSCURA_TEST_API="{{ api }}" ./gradlew :lib:integrationTest

# Generate the Swift protobuf bindings (needs protoc). Every Swift and iOS build runs this first.
swift-proto:
    ./swift/scripts/gen-proto.sh

# The kit builds and tests for iOS only: libsignal's prebuilt core has no macOS slice.
swift_xcodebuild := "xcodebuild -scheme ObscuraKit -derivedDataPath .build/DerivedData -skipPackagePluginValidation"

# Build the Swift package for the iOS simulator.
swift-build: swift-proto
    cd swift && {{ swift_xcodebuild }} -destination 'generic/platform=iOS Simulator' build

# Run Swift unit tests on an iOS simulator, with the coverage gate. Narrow the
# run without the gate, e.g.: just swift-unit UnitTests/ClientTests
swift-unit filter="UnitTests": swift-proto
    cd swift && rm -rf .build/DerivedData/Build/ProfileData && mkdir -p .build/reports && \
        {{ swift_xcodebuild }} -destination "platform=iOS Simulator,id=$(scripts/simulator.sh)" \
        -only-testing:{{ quote(filter) }} -enableCodeCoverage YES test 2>&1 | tee .build/reports/unit-tests.log
    {{ if filter == "UnitTests" { "./swift/scripts/coverage.sh" } else { "echo 'Coverage is gated only for the whole suite.'" } }}

# Run Swift server-dependent tests on an iOS simulator against an explicit local
# endpoint. xcodebuild hands TEST_RUNNER_ variables to the tests without the prefix.
swift-integration api="http://localhost:3000" filter="ScenarioTests": swift-proto
    @curl -fsS "{{ api }}/openapi.yaml" >/dev/null || { echo "error: no Obscura server at {{ api }}" >&2; exit 1; }
    cd swift && mkdir -p .build/reports && TEST_RUNNER_OBSCURA_TEST_API={{ quote(api) }} \
        {{ swift_xcodebuild }} -destination "platform=iOS Simulator,id=$(scripts/simulator.sh)" \
        -only-testing:{{ quote(filter) }} -test-iterations 6 -run-tests-until-failure test 2>&1 | tee .build/reports/integration-tests.log

# Create or refresh the compile-only Firebase stub when no real config exists.
android-config:
    @if [[ ! -f android/app/google-services.json ]] || grep -q '"project_id": "local-stub"' android/app/google-services.json; then cp android/app/google-services.stub.json android/app/google-services.json; echo "Prepared Firebase stub for compile-only builds."; else echo "Using existing android/app/google-services.json."; fi

# Reject an env other than dev or prod.
[private]
check-env env:
    @[[ {{quote(env)}} == dev || {{quote(env)}} == prod ]] || { echo "error: env must be 'dev' or 'prod'" >&2; exit 1; }

# Run the Android app on a device or emulator (env: dev or prod).
android-run env="dev": (check-env env) android-config ensure-node-modules
    npm run android -- --mode {{env}}Debug {{ if env == "dev" { "--appIdSuffix dev" } else { "" } }}

# Assemble a compile-only Android release APK (env: dev or prod). Pass an
# architecture list and false to skip R8 for a faster build:
# just android-build arm64-v8a false
android-build architectures="" minify="true" env="dev": (check-env env) android-config ensure-node-modules
    ./android/gradlew -p android :app:assemble{{capitalize(env)}}Release --parallel -PenableProguardInReleaseBuilds={{quote(minify)}} {{ if architectures != "" { "-PreactNativeArchitectures=" + quote(architectures) } else { "" } }}

# Bundle a signed, minified Android App Bundle (.aab) with real Firebase configuration.
# Signing credentials are read from android/keystore.properties or the
# ANDROID_RELEASE_* environment variables.
android-bundle version_code version_name env="dev": (check-env env) android-config ensure-node-modules
    ./android/gradlew -p android :app:bundle{{capitalize(env)}}Release --parallel -PenableProguardInReleaseBuilds=true -PobscuraSignedBundle=true -PobscuraVersionCode={{quote(version_code)}} -PobscuraVersionName={{quote(version_name)}}

# Clean Android build outputs.
android-clean: ensure-node-modules
    rm -rf android/app/.cxx
    ./android/gradlew -p android clean --parallel

# Clean iOS build outputs.
ios-clean:
    rm -rf ios/build
    @if [[ -d ios/Pods ]]; then GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura clean; fi

# Prepare all native iOS dependencies.
[private]
ios-prepare: ensure-node-modules swift-proto
    cd ios && pod install

# Build the iOS app for a generic simulator (env: dev or prod). Pass an
# architecture for a faster compile-only build, for example: just ios-build arm64
ios-build architecture="" env="dev": (check-env env) ios-prepare
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -configuration Debug -xcconfig ios/Config/{{capitalize(env)}}.xcconfig -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO {{ if architecture != "" { "ARCHS=" + quote(architecture) + " ONLY_ACTIVE_ARCH=YES" } else { "" } }} build

# Archive the iOS device build for App Store Connect / TestFlight (env: dev or
# prod). The version defaults to package.json's.
ios-archive archive_path="ios/build/Obscura.xcarchive" build_number="" version="" env="dev": (check-env env) ios-prepare
    #!/usr/bin/env bash
    set -euo pipefail
    version={{quote(version)}}
    build_number={{quote(build_number)}}
    args=(MARKETING_VERSION="${version:-$(node -p "require('./package.json').version")}")
    [[ -z "$build_number" ]] || args+=(CURRENT_PROJECT_VERSION="$build_number")
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -configuration Release -xcconfig ios/Config/{{capitalize(env)}}.xcconfig -destination 'generic/platform=iOS' -archivePath {{quote(archive_path)}} "${args[@]}" archive

# Export a signed App Store IPA from an archive (env: dev or prod).
ios-export archive_path="ios/build/Obscura.xcarchive" export_path="ios/build/export" env="dev": (check-env env)
    xcodebuild -exportArchive -archivePath {{quote(archive_path)}} -exportPath {{quote(export_path)}} -exportOptionsPlist ios/Config/{{capitalize(env)}}-ExportOptions.plist

# Dispatch a dev release build (Obscura Dev -> Play Internal + TestFlight) from main.
release-dev:
    gh workflow run release-dev.yml --ref main

# Dispatch a prod release build (Obscura -> Play Internal + TestFlight) from main.
release-prod:
    gh workflow run release-prod.yml --ref main
