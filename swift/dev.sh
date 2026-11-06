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
  # directly creates an identity collision.
  rm -rf "$LIBSIGNAL_SWIFT_PACKAGE"
  cp -pR "$LIBSIGNAL_SWIFT_SOURCE" "$LIBSIGNAL_SWIFT_PACKAGE"
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
      # (UnitTests.xctest vs. <Package>PackageTests.xctest), so locate it.
      BIN_PATH="$(LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT build --show-bin-path)"
      PROFDATA="$(dirname "$(LIBRARY_PATH="$LIBSIGNAL_PATH" $SWIFT test --show-codecov-path)")/default.profdata"
      BUNDLE="$(find "$BIN_PATH" -maxdepth 1 -name '*.xctest' | head -n 1)"
      if [ -z "$BUNDLE" ]; then
        echo "error: no .xctest bundle found in $BIN_PATH" >&2
        exit 1
      fi
      BINARY="$BUNDLE/Contents/MacOS/$(basename "$BUNDLE" .xctest)"
      REPORT="$(xcrun llvm-cov report \
        "$BINARY" \
        -instr-profile="$PROFDATA" \
        --ignore-filename-regex='.build|Tests|Sources/ObscuraKit/Proto' \
        Sources/ObscuraKit)"
      echo "$REPORT"
      awk '
        /^TOTAL/ {
          found = 1
          regions = $4; gsub(/%/, "", regions)
          lines = $10; gsub(/%/, "", lines)
          if (lines + 0 < 95.0 || regions + 0 < 90.0) {
            printf "error: coverage below threshold (lines %.2f%% < 95%%, regions %.2f%% < 90%%)\n", lines, regions > "/dev/stderr"
            exit 1
          }
        }
        END {
          if (!found) {
            print "error: missing TOTAL line in llvm-cov report" > "/dev/stderr"
            exit 1
          }
        }
      ' <<< "$REPORT"
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
