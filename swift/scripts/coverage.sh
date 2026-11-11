#!/usr/bin/env bash
#
# The coverage gate for a full unit test run: lines and regions of Sources/ObscuraKit, outside the
# generated protobuf code, must reach 95% and 90%. Reads the profile `just swift-unit` leaves in
# .build/DerivedData and writes coverage.txt and coverage.json to .build/reports.
#
# DatabaseSecret is left out: its Keychain calls need a host app's entitlement, which package tests
# on a simulator lack.
#
set -euo pipefail

cd "$(dirname "$0")/.."

# `just swift-unit` clears ProfileData first, so exactly one profile is this run's.
shopt -s nullglob
profiles=(.build/DerivedData/Build/ProfileData/*/Coverage.profdata)
binary=.build/DerivedData/Build/Products/Debug-iphonesimulator/UnitTests.xctest/UnitTests
if (( ${#profiles[@]} != 1 )) || [[ ! -f "$binary" ]]; then
  echo "error: expected one coverage profile and the UnitTests bundle; found ${#profiles[@]} profiles" >&2
  exit 1
fi
args=("$binary" -instr-profile="${profiles[0]}"
  --ignore-filename-regex='.build|Tests|Sources/ObscuraKit/Proto|Crypto/DatabaseSecret.swift' Sources/ObscuraKit)

mkdir -p .build/reports
xcrun llvm-cov report "${args[@]}" | tee .build/reports/coverage.txt
summary="$(xcrun llvm-cov export -summary-only "${args[@]}")"
printf '%s\n' "$summary" > .build/reports/coverage.json
lines="$(plutil -extract data.0.totals.lines.percent raw -o - - <<< "$summary")"
regions="$(plutil -extract data.0.totals.regions.percent raw -o - - <<< "$summary")"
if ! awk -v lines="$lines" -v regions="$regions" 'BEGIN { exit !(lines >= 95 && regions >= 90) }'; then
  printf 'error: coverage below threshold (lines %.2f%% < 95%%, regions %.2f%% < 90%%)\n' "$lines" "$regions" >&2
  exit 1
fi
