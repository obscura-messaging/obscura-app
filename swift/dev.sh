#!/bin/bash
# Dev helper - runs swift commands with Xcode's Swift toolchain
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

SWIFT="xcrun swift"
LIBSIGNAL_PATH="$ROOT/vendored/libsignal/target/release"
LIBSIGNAL_SWIFT_SOURCE="$ROOT/vendored/libsignal/swift"
LIBSIGNAL_SWIFT_PACKAGE="$ROOT/vendored/LibSignalClient"

prepare_libsignal_package() {
  if [ ! -f "$LIBSIGNAL_SWIFT_SOURCE/Package.swift" ]; then
    echo "error: libsignal v0.40.0 is not checked out at vendored/libsignal" >&2
    exit 1
  fi

  # SwiftPM derives local package identity from the final path component. The
  # monorepo package itself lives at swift/, so depending on libsignal/swift
  # directly creates an identity collision. Copy once when missing or changed.
  if [ ! -f "$LIBSIGNAL_SWIFT_PACKAGE/Package.swift" ] || ! cmp -s "$LIBSIGNAL_SWIFT_SOURCE/Package.swift" "$LIBSIGNAL_SWIFT_PACKAGE/Package.swift"; then
    rm -rf "$LIBSIGNAL_SWIFT_PACKAGE"
    cp -pR "$LIBSIGNAL_SWIFT_SOURCE" "$LIBSIGNAL_SWIFT_PACKAGE"
  fi
}

case "${1:-test}" in
  prepare)
    prepare_libsignal_package
    echo "Prepared vendored/LibSignalClient for SwiftPM."
    ;;
  build)
    prepare_libsignal_package
    LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT build "${@:2}"
    ;;
  test)
    prepare_libsignal_package
    if [[ "${*:2}" == *"UnitTests"* ]]; then
      LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT test --enable-code-coverage "${@:2}"
      # SwiftPM names the test bundle differently across toolchains
      # (UnitTests.xctest vs. <Package>PackageTests.xctest), so locate it from codecov dir.
      CODECOV_DIR="$(dirname "$(LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT test --show-codecov-path)")"
      BIN_PATH="$(dirname "$CODECOV_DIR")"
      PROFDATA="$CODECOV_DIR/default.profdata"
      BUNDLE="$(find "$BIN_PATH" -maxdepth 1 -name '*.xctest' | head -n 1)"
      if [ -z "$BUNDLE" ]; then
        echo "error: no .xctest bundle found in $BIN_PATH" >&2
        exit 1
      fi
      BINARY="$BUNDLE/Contents/MacOS/$(basename "$BUNDLE" .xctest)"
      COV_ARGS=("$BINARY" -instr-profile="$PROFDATA" --ignore-filename-regex='.build|Tests|Sources/ObscuraKit/Proto' Sources/ObscuraKit)
      xcrun llvm-cov report "${COV_ARGS[@]}"
      SUMMARY="$(xcrun llvm-cov export -summary-only "${COV_ARGS[@]}")"
      LINES="$(plutil -extract data.0.totals.lines.percent raw -o - - <<< "$SUMMARY")"
      REGIONS="$(plutil -extract data.0.totals.regions.percent raw -o - - <<< "$SUMMARY")"
      if ! awk -v lines="$LINES" -v regions="$REGIONS" 'BEGIN { exit !(lines >= 95 && regions >= 90) }'; then
        printf 'error: coverage below threshold (lines %.2f%% < 95%%, regions %.2f%% < 90%%)\n' "$LINES" "$REGIONS" >&2
        exit 1
      fi
    else
      LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT test "${@:2}"
    fi
    ;;
  shell)
    prepare_libsignal_package
    LIBRARY_PATH="$LIBSIGNAL_PATH" bash
    ;;
  *)
    echo "Usage: ./dev.sh [prepare|build|test|shell]"
    echo "Extra args passed to swift, e.g.: ./dev.sh test --filter CoreFlowTests"
    ;;
esac
