#!/bin/bash
# Builds and tests the kit on an iOS simulator. libsignal's prebuilt Rust core has iOS slices only, so
# nothing here runs on the macOS host, as libsignal's own swift/run_ios_tests.sh does.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DERIVED="$ROOT/.build/DerivedData"
REPORTS="$ROOT/.build/reports"
SCHEME="ObscuraKit-Package"

# The newest available iPhone simulator.
simulator() {
  local id
  id="$(xcrun simctl list --json devices available iPhone |
    python3 -c 'import json, sys
runtimes = json.load(sys.stdin)["devices"]
for runtime in sorted(runtimes, reverse=True):
    if runtimes[runtime]:
        print(runtimes[runtime][0]["udid"])
        break')"
  if [ -z "$id" ]; then
    echo "error: no iPhone simulator available" >&2
    exit 1
  fi
  echo "$id"
}

xcodebuild_kit() {
  xcodebuild -scheme "$SCHEME" -derivedDataPath "$DERIVED" -skipPackagePluginValidation "$@"
}

# Lines and regions of Sources/ObscuraKit outside the generated protobuf code, from the
# simulator run's profile; fails below 95% of lines or 90% of regions.
coverage() {
  local profdata bundle binary
  profdata="$(find "$DERIVED/Build/ProfileData" -name Coverage.profdata -print -quit)"
  bundle="$(find "$DERIVED/Build/Products" -path '*iphonesimulator*' -name '*.xctest' -print -quit)"
  if [ -z "$profdata" ] || [ -z "$bundle" ]; then
    echo "error: no coverage profile or test bundle under $DERIVED" >&2
    exit 1
  fi
  binary="$bundle/$(basename "$bundle" .xctest)"
  local args=("$binary" -instr-profile="$profdata" --ignore-filename-regex='.build|Tests|Sources/ObscuraKit/Proto' Sources/ObscuraKit)
  xcrun llvm-cov report "${args[@]}" | tee "$REPORTS/coverage.txt"
  local summary lines regions
  summary="$(xcrun llvm-cov export -summary-only "${args[@]}")"
  printf '%s\n' "$summary" > "$REPORTS/coverage.json"
  lines="$(plutil -extract data.0.totals.lines.percent raw -o - - <<< "$summary")"
  regions="$(plutil -extract data.0.totals.regions.percent raw -o - - <<< "$summary")"
  if ! awk -v lines="$lines" -v regions="$regions" 'BEGIN { exit !(lines >= 95 && regions >= 90) }'; then
    printf 'error: coverage below threshold (lines %.2f%% < 95%%, regions %.2f%% < 90%%)\n' "$lines" "$regions" >&2
    exit 1
  fi
}

case "${1:-test}" in
  build)
    xcodebuild_kit -destination 'generic/platform=iOS Simulator' build "${@:2}"
    ;;
  test)
    # Usage: ./dev.sh test UnitTests|ScenarioTests [xcodebuild args...]
    target="${2:?usage: ./dev.sh test UnitTests|ScenarioTests}"
    mkdir -p "$REPORTS"
    # xcodebuild hands TEST_RUNNER_-prefixed variables to the tests without the prefix.
    if [ -n "${OBSCURA_TEST_API:-}" ]; then export TEST_RUNNER_OBSCURA_TEST_API="$OBSCURA_TEST_API"; fi
    destination="platform=iOS Simulator,id=$(simulator)"
    case "$target" in
      UnitTests)
        xcodebuild_kit -destination "$destination" -only-testing:UnitTests -enableCodeCoverage YES test "${@:3}" 2>&1 |
          tee "$REPORTS/unit-tests.log"
        coverage
        ;;
      ScenarioTests)
        xcodebuild_kit -destination "$destination" -only-testing:ScenarioTests test "${@:3}" 2>&1 |
          tee "$REPORTS/integration-tests.log"
        ;;
      *)
        echo "error: unknown test target $target" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Usage: ./dev.sh [build|test UnitTests|test ScenarioTests]"
    echo "Extra args go to xcodebuild, e.g.: ./dev.sh test UnitTests -only-testing:UnitTests/ClientTests"
    ;;
esac
