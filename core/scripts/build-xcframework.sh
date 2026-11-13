#!/usr/bin/env bash
#
# Builds obscura-core as ObscuraCoreFFI.xcframework (iOS device + simulator static libraries,
# with the UniFFI C header and module map) and generates the Swift bindings, both into the
# SwiftPM package at core/swift/ObscuraCore. macOS with Xcode only.
#
# Usage: core/scripts/build-xcframework.sh [openssl|commoncrypto]
#   openssl (default)  SQLCipher over vendored OpenSSL, the same crypto as Android.
#   commoncrypto       SQLCipher over Apple's CommonCrypto; no OpenSSL in the binary.
#
set -euo pipefail

crypto="${1:-openssl}"
case "$crypto" in
openssl | commoncrypto) ;;
*)
    echo "error: unknown crypto '$crypto' (openssl or commoncrypto)" >&2
    exit 2
    ;;
esac

core="$(cd "$(dirname "$0")/.." && pwd)"
package="$core/swift/ObscuraCore"
target_dir="${CARGO_TARGET_DIR:-$core/target}"
features=(--no-default-features --features "sqlcipher-$crypto")
# The arm64 simulator slice covers Apple silicon Macs and runners; add x86_64-apple-ios for Intel.
targets=(aarch64-apple-ios aarch64-apple-ios-sim)
# Matches the Swift kit's minimum, so the static library links into the app without warnings.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"
# libsqlite3-sys would use an OpenSSL named here instead of CommonCrypto or the vendored copy.
unset OPENSSL_DIR OPENSSL_LIB_DIR OPENSSL_INCLUDE_DIR SQLCIPHER_LIB_DIR SQLCIPHER_INCLUDE_DIR

cd "$core"
start=$SECONDS
for target in "${targets[@]}"; do
    t0=$SECONDS
    # Only the staticlib: the cdylib and rlib crate types are not needed for an XCFramework.
    cargo rustc --locked --release --lib --crate-type staticlib --target "$target" "${features[@]}"
    echo "timing: $target staticlib built in $((SECONDS - t0))s"
done
rust_seconds=$((SECONDS - start))

t0=$SECONDS
bindings="$target_dir/swift-bindings"
rm -rf "$bindings"
# Library mode reads the UniFFI metadata embedded in the static library; the bindgen binary
# itself is a host build.
cargo run --locked --features "bindgen,sqlcipher-$crypto" --no-default-features --bin uniffi-bindgen -- \
    generate --library "$target_dir/aarch64-apple-ios/release/libobscura_core.a" \
    --language swift --out-dir "$bindings"
echo "timing: bindings generated in $((SECONDS - t0))s"

# Headers sit in a directory named after the clang module, so Xcode copies them to
# include/obscura_coreFFI/ and the module map cannot clash with another package's
# include/module.modulemap (libsignal's XCFramework ships one too).
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
# The archive carries debug sections the app's link and strip drop; this is closer to its cost.
stripped="$target_dir/libobscura_core-stripped.a"
xcrun strip -S -o "$stripped" "$target_dir/aarch64-apple-ios/release/libobscura_core.a"
echo "size: aarch64-apple-ios libobscura_core.a without debug symbols $(du -k "$stripped" | cut -f1) KiB"
echo "size: ObscuraCoreFFI.xcframework $(du -sk "$xcframework" | cut -f1) KiB"
