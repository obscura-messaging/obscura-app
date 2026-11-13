#!/usr/bin/env bash
# Builds release libobscura_core.so for Android and generates its Kotlin bindings.
#
#   core/scripts/build-android.sh <jniLibs dir> <kotlin source dir> [abi ...]
#
# ABIs default to arm64-v8a and x86_64. The .so files are stripped in the output dir only:
# bindings are generated from the unstripped library in target/, because UniFFI reads its
# interface metadata from symbols that stripping removes.
set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "usage: $0 <jniLibs dir> <kotlin source dir> [abi ...]" >&2
    exit 64
fi
jni_libs_dir=$(realpath -m "$1")
kotlin_dir=$(realpath -m "$2")
shift 2
abis=("$@")
[ "${#abis[@]}" -gt 0 ] || abis=(arm64-v8a x86_64)

core_dir=$(cd "$(dirname "$0")/.." && pwd)
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
# The app's NDK (ndkVersion in android/build.gradle), so the core and the app agree.
: "${ANDROID_NDK_HOME:=$ANDROID_HOME/ndk/27.1.12297006}"
export ANDROID_HOME ANDROID_NDK_HOME
# The app's minSdkVersion.
api_level=${OBSCURA_ANDROID_API:-24}
strip_bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"

declare -A rust_target=(
    [arm64-v8a]=aarch64-linux-android
    [x86_64]=x86_64-linux-android
    [armeabi-v7a]=armv7-linux-androideabi
    [x86]=i686-linux-android
)

cd "$core_dir"
target_args=()
for abi in "${abis[@]}"; do
    triple=${rust_target[$abi]:-}
    [ -n "$triple" ] || { echo "unknown ABI $abi" >&2; exit 64; }
    target_args+=(-t "$abi")
    # 16 KB page alignment, required on 16 KB-page devices (Android 15+). Set per target so
    # host builds (build scripts, the bindgen) keep their own flags and cache.
    env_triple=$(echo "$triple" | tr 'a-z-' 'A-Z_')
    export "CARGO_TARGET_${env_triple}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384"
done

mkdir -p "$jni_libs_dir"
cargo ndk "${target_args[@]}" --platform "$api_level" -o "$jni_libs_dir" build --release --lib

for abi in "${abis[@]}"; do
    "$strip_bin" --strip-unneeded "$jni_libs_dir/$abi/libobscura_core.so"
done

# Host-built bindgen; it can read any target's library as long as it is unstripped.
first_target=${rust_target[${abis[0]}]}
mkdir -p "$kotlin_dir"
cargo run --quiet --release --features bindgen --bin uniffi-bindgen -- \
    generate --library "target/$first_target/release/libobscura_core.so" \
    --language kotlin --no-format --out-dir "$kotlin_dir"

ls -l "$jni_libs_dir"/*/libobscura_core.so
