#!/usr/bin/env bash
#
# Builds obscura-core as ObscuraCoreFFI.xcframework (iOS device + simulator static libraries,
# with the UniFFI C header and module map) and generates the Swift bindings, both into the
# SwiftPM package at core/swift/ObscuraCore. macOS with Xcode only.
#
# Usage: core/scripts/build-xcframework.sh [commoncrypto|openssl] [all|sim|device]
#   commoncrypto (default)  SQLCipher over Apple's CommonCrypto; no OpenSSL in the binary.
#   openssl                 SQLCipher over vendored OpenSSL, the same crypto as Android.
#   all (default)           Both iOS device (aarch64-apple-ios) and simulator (aarch64-apple-ios-sim).
#   sim                     Simulator slice only (aarch64-apple-ios-sim).
#   device                  Device slice only (aarch64-apple-ios).
#
set -euo pipefail

crypto="${1:-commoncrypto}"
case "$crypto" in
openssl | commoncrypto) ;;
*)
    echo "error: unknown crypto '$crypto' (commoncrypto or openssl)" >&2
    exit 2
    ;;
esac

slice="${2:-all}"
case "$slice" in
all)
    targets=(aarch64-apple-ios aarch64-apple-ios-sim)
    ;;
sim)
    targets=(aarch64-apple-ios-sim)
    ;;
device)
    targets=(aarch64-apple-ios)
    ;;
*)
    echo "error: unknown slice '$slice' (all, sim, or device)" >&2
    exit 2
    ;;
esac

core="$(cd "$(dirname "$0")/.." && pwd)"
package="$core/swift/ObscuraCore"
target_dir="${CARGO_TARGET_DIR:-$core/target}"
features=(--no-default-features --features "sqlcipher-$crypto")
# Matches the iOS deployment target so the static library links into the app without warnings.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"
# libsqlite3-sys would use an OpenSSL named here instead of CommonCrypto or the vendored copy.
unset OPENSSL_DIR OPENSSL_LIB_DIR OPENSSL_INCLUDE_DIR SQLCIPHER_LIB_DIR SQLCIPHER_INCLUDE_DIR

cd "$core"
start=$SECONDS
for target in "${targets[@]}"; do
    t0=$SECONDS
    # Only the staticlib: the cdylib and rlib crate types are not needed for an XCFramework.
    cargo rustc --locked --release -p obscura-core --lib --crate-type staticlib --target "$target" "${features[@]}"
    echo "timing: $target staticlib built in $((SECONDS - t0))s"
done
rust_seconds=$((SECONDS - start))

t0=$SECONDS
bindings="$target_dir/swift-bindings"
rm -rf "$bindings"
first_target="${targets[0]}"
# Library mode reads the UniFFI metadata embedded in the static library; the bindgen binary
# lives in a tiny workspace crate so Cargo does not compile libsignal/sqlcipher for the host.
cargo run --locked --release -p obscura-core-bindgen --bin uniffi-bindgen -- \
    generate --library "$target_dir/$first_target/release/libobscura_core.a" \
    --language swift --out-dir "$bindings"
echo "timing: bindings generated in $((SECONDS - t0))s"

# Headers sit in a directory named after the clang module, so Xcode copies them to
# include/obscura_coreFFI/ and the module map cannot clash with another package's
# include/module.modulemap.
headers="$target_dir/xcframework-headers"
rm -rf "$headers"
mkdir -p "$headers/obscura_coreFFI"
cp "$bindings/obscura_coreFFI.h" "$headers/obscura_coreFFI/"
cp "$bindings/obscura_coreFFI.modulemap" "$headers/obscura_coreFFI/module.modulemap"

xcframework="$package/ObscuraCoreFFI.xcframework"
rm -rf "$xcframework"
args=()
for target in "${targets[@]}"; do
    args+=(-library "$target_dir/$target/release/libobscura_core.a" -headers "$headers")
done
xcodebuild -create-xcframework "${args[@]}" -output "$xcframework"

mkdir -p "$package/Sources/ObscuraCore"
cp "$bindings/obscura_core.swift" "$package/Sources/ObscuraCore/obscura_core.swift"

echo "timing: rust ($crypto, ${#targets[@]} targets) ${rust_seconds}s, total $((SECONDS - start))s"
for target in "${targets[@]}"; do
    lib="$target_dir/$target/release/libobscura_core.a"
    echo "size: $target libobscura_core.a $(du -k "$lib" | cut -f1) KiB"
done
stripped="$target_dir/libobscura_core-stripped.a"
xcrun strip -S -o "$stripped" "$target_dir/$first_target/release/libobscura_core.a"
echo "size: $first_target libobscura_core.a without debug symbols $(du -k "$stripped" | cut -f1) KiB"
echo "size: ObscuraCoreFFI.xcframework $(du -sk "$xcframework" | cut -f1) KiB"
