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

# Validate protocol conformance fixtures.
protocol-vectors:
    python3 protocol/conformance/validate.py

# Run Kotlin unit tests.
kotlin-unit:
    cd kotlin && ../scripts/run-with-java-21.sh ./gradlew :lib:test --no-daemon

# Run the Kotlin CI tasks in one Gradle process.
kotlin-ci:
    cd kotlin && ../scripts/run-with-java-21.sh ./gradlew :lib:test :lib:koverHtmlReport :lib:koverXmlReport :lib:koverVerify --no-daemon

# Run the full fast Kotlin CI gate.
kotlin-check: protocol-vectors kotlin-ci

# Run Kotlin server-dependent tests against an explicit local endpoint.
kotlin-integration api="http://localhost:3000":
    @curl -fsS "{{ api }}/openapi.yaml" >/dev/null || { echo "error: no Obscura server at {{ api }}" >&2; exit 1; }
    cd kotlin && OBSCURA_TEST_API="{{ api }}" ../scripts/run-with-java-21.sh ./gradlew :lib:integrationTest --no-daemon

# Fetch and build the pinned host libsignal FFI.
[private]
swift-bootstrap:
    ./swift/scripts/bootstrap-libsignal.sh host

# Build the Swift package.
swift-build: swift-bootstrap
    cd swift && ./dev.sh build

# Run Swift unit tests.
swift-unit: swift-bootstrap
    cd swift && ./dev.sh test --filter UnitTests

# Run Swift server-dependent tests against an explicit local endpoint.
swift-integration api="http://localhost:3000": swift-bootstrap
    @curl -fsS "{{ api }}/openapi.yaml" >/dev/null || { echo "error: no Obscura server at {{ api }}" >&2; exit 1; }
    cd swift && OBSCURA_TEST_API="{{ api }}" ./dev.sh test --filter ScenarioTests

# Create or refresh the compile-only Firebase stub when no real config exists.
android-config:
    @if [[ ! -f android/app/google-services.json ]] || grep -q '"project_id": "local-stub"' android/app/google-services.json; then cp android/app/google-services.stub.json android/app/google-services.json; echo "Prepared Firebase stub for compile-only builds."; else echo "Using existing android/app/google-services.json."; fi

# Run the Android app.
android-run: android-config ensure-node-modules
    ./scripts/run-with-android-env.sh npm run android

# Assemble a compile-only Android release APK (env: dev or prod). Pass an
# architecture list and false to skip R8 for a faster build:
# just android-apk arm64-v8a false
android-apk architectures="" minify="true" env="dev": android-config ensure-node-modules
    architectures={{quote(architectures)}}; minify={{quote(minify)}}; env={{quote(env)}}; args=("-PenableProguardInReleaseBuilds=$minify" "-PobscuraEnv=$env"); [[ -z "$architectures" ]] || args+=("-PreactNativeArchitectures=$architectures"); ./scripts/run-with-android-env.sh ./android/gradlew -p android :app:assembleRelease --parallel "${args[@]}"

# Bundle a signed, minified Android App Bundle (.aab) with real Firebase configuration.
# Signing credentials are read from android/keystore.properties or the
# ANDROID_RELEASE_* environment variables.
android-bundle version_code version_name env="dev": android-config ensure-node-modules
    version_code={{quote(version_code)}}; version_name={{quote(version_name)}}; env={{quote(env)}}; [[ "$version_code" =~ ^[1-9][0-9]*$ ]] || { echo "error: bundle version code must be a positive integer" >&2; exit 1; }; [[ -n "$version_name" ]] || { echo "error: bundle version name is required" >&2; exit 1; }; ./scripts/run-with-android-env.sh ./android/gradlew -p android :app:bundleRelease --parallel -PenableProguardInReleaseBuilds=true -PobscuraSignedBundle=true -PobscuraEnv="$env" -PobscuraVersionCode="$version_code" -PobscuraVersionName="$version_name"

# Clean Android build outputs.
android-clean: ensure-node-modules
    rm -rf android/app/.cxx
    ./scripts/run-with-android-env.sh ./android/gradlew -p android clean --parallel

# Prepare all native iOS dependencies.
[private]
ios-prepare libsignal_target="ios-sim": ensure-node-modules
    ./swift/scripts/bootstrap-libsignal.sh {{quote(libsignal_target)}}
    ./swift/dev.sh prepare
    cd ios && pod install

# Build the iOS app for a generic simulator (env: dev or prod). Pass an
# architecture for a faster compile-only build, for example: just ios-build arm64
ios-build architecture="" env="dev": ios-prepare
    architecture={{quote(architecture)}}; env={{quote(env)}}; if [[ "$env" == "prod" ]]; then bundle_id="dev.barrelmaker.obscura"; display_name="Obscura"; api_host="obscura.barrelmaker.dev"; elif [[ "$env" == "dev" ]]; then bundle_id="dev.barrelmaker.obscura.dev"; display_name="Obscura Dev"; api_host="devscura.barrelmaker.dev"; else echo "error: env must be 'dev' or 'prod'" >&2; exit 1; fi; args=(COMPILER_INDEX_STORE_ENABLE=NO PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" OBSCURA_DISPLAY_NAME="$display_name" OBSCURA_API_HOST="$api_host"); [[ -z "$architecture" ]] || args+=(ARCHS="$architecture" ONLY_ACTIVE_ARCH=YES); GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO "${args[@]}" build

# Archive the iOS device build for App Store Connect / TestFlight (env: dev or prod).
ios-archive archive_path="ios/build/Obscura.xcarchive" build_number="" version="" env="dev" profile_specifier="": (ios-prepare "ios-device")
    build_number={{quote(build_number)}}; version={{quote(version)}}; env={{quote(env)}}; profile_specifier={{quote(profile_specifier)}}; [[ -n "$version" ]] || version="$(node -p "require('./package.json').version")"; if [[ "$env" == "prod" ]]; then bundle_id="dev.barrelmaker.obscura"; display_name="Obscura"; api_host="obscura.barrelmaker.dev"; default_profile="Obscura App Store"; elif [[ "$env" == "dev" ]]; then bundle_id="dev.barrelmaker.obscura.dev"; display_name="Obscura Dev"; api_host="devscura.barrelmaker.dev"; default_profile="Obscura Dev App Store"; else echo "error: env must be 'dev' or 'prod'" >&2; exit 1; fi; args=(PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" OBSCURA_DISPLAY_NAME="$display_name" OBSCURA_API_HOST="$api_host" PROVISIONING_PROFILE_SPECIFIER="${profile_specifier:-$default_profile}" MARKETING_VERSION="$version"); [[ -z "$build_number" ]] || args+=(CURRENT_PROJECT_VERSION="$build_number"); GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -configuration Release -destination 'generic/platform=iOS' -archivePath {{quote(archive_path)}} "${args[@]}" archive

# Dispatch a dev release build (Obscura Dev -> Play Internal + TestFlight) from main.
release-dev:
    gh workflow run release-dev.yml --ref main

# Dispatch a prod release build (Obscura -> Play Internal + TestFlight) from main.
release-prod:
    gh workflow run release-prod.yml --ref main
