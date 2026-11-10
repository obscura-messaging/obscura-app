#!/bin/bash
# Builds and tests the kit on an iOS simulator. libsignal's prebuilt Rust core has iOS slices only, so
# nothing here runs on the macOS host, as libsignal's own swift/run_ios_tests.sh does.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DERIVED="$ROOT/.build/DerivedData"
REPORTS="$ROOT/.build/reports"
# Xcode names a package's scheme after its single product, or adds "<name>-Package" for several.
scheme() {
  xcodebuild -list -json | python3 -c 'import json, sys
schemes = json.load(sys.stdin)["workspace"]["schemes"]
print("ObscuraKit-Package" if "ObscuraKit-Package" in schemes else "ObscuraKit")'
}

# An iPhone simulator on the newest available iOS runtime, compared by version number.
simulator() {
  local id
  id="$(xcrun simctl list --json devices available iPhone |
    python3 -c 'import json, re, sys
runtimes = {k: v for k, v in json.load(sys.stdin)["devices"].items() if v}
version = lambda key: [int(n) for n in re.findall(r"\d+", key.rsplit(".", 1)[-1])]
if runtimes:
    print(runtimes[max(runtimes, key=version)][0]["udid"])')"
  if [ -z "$id" ]; then
    echo "error: no iPhone simulator available" >&2
    exit 1
  fi
  echo "$id"
}

xcodebuild_kit() {
  xcodebuild -scheme "$(scheme)" -derivedDataPath "$DERIVED" -skipPackagePluginValidation "$@"
}

# Lines and regions of Sources/ObscuraKit outside the generated protobuf code, from the
# simulator run's profile; fails below 95% of lines or 90% of regions. DatabaseSecret is left out:
# its Keychain calls need a host app's entitlement, which package tests on a simulator lack.
coverage() {
  local profdata bundle binary
  profdata="$(find "$DERIVED/Build/ProfileData" -name Coverage.profdata -print -quit)"
  bundle="$(find "$DERIVED/Build/Products" -path '*iphonesimulator*' -name '*.xctest' -print -quit)"
  if [ -z "$profdata" ] || [ -z "$bundle" ]; then
    echo "error: no coverage profile or test bundle under $DERIVED" >&2
    exit 1
  fi
  binary="$bundle/$(basename "$bundle" .xctest)"
  local args=("$binary" -instr-profile="$profdata" --ignore-filename-regex='.build|Tests|Sources/ObscuraKit/Proto|Crypto/DatabaseSecret.swift' Sources/ObscuraKit)
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
    # Usage: ./dev.sh test UnitTests|ScenarioTests[/Class[/test]] [xcodebuild args...]
    target="${2:?usage: ./dev.sh test UnitTests|ScenarioTests[/Class[/test]]}"
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
      # Part of a target: no coverage gate, which only means something for the whole suite.
      UnitTests/*)
        xcodebuild_kit -destination "$destination" -only-testing:"$target" test "${@:3}" 2>&1 |
          tee "$REPORTS/unit-tests.log"
        ;;
      ScenarioTests|ScenarioTests/*)
        xcodebuild_kit -destination "$destination" -only-testing:"$target" test "${@:3}" 2>&1 |
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
    echo "Run part of a target, e.g.: ./dev.sh test UnitTests/ClientTests; extra args go to xcodebuild"
    ;;
esac
