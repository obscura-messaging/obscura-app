#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/vendored/libsignal"
REF="${LIBSIGNAL_REF:-7ef4efdb85d8b2ebd77f3cf1e2b542a2115033c5}"
MODE="${1:-host}"

case "$MODE" in
  host)
    ARCHIVE="$SOURCE/target/release/libsignal_ffi.a"
    ;;
  ios-sim)
    TARGET="aarch64-apple-ios-sim"
    ARCHIVE="$SOURCE/target/$TARGET/release/libsignal_ffi.a"
    ;;
  ios-device)
    TARGET="aarch64-apple-ios"
    ARCHIVE="$SOURCE/target/$TARGET/release/libsignal_ffi.a"
    ;;
  *)
    echo "usage: $0 [host|ios-sim|ios-device]" >&2
    exit 2
    ;;
esac

command -v git >/dev/null 2>&1 || {
  echo "error: git is required to build libsignal" >&2
  exit 1
}

if [[ -d "$SOURCE/.git" ]] &&
   [[ "$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)" == "$REF" ]] &&
   [[ -f "$ARCHIVE" ]]; then
  echo "libsignal $REF ($MODE) is already built."
  exit 0
fi

for tool in rustup protoc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required to build libsignal" >&2
    exit 1
  }
done

mkdir -p "$ROOT/vendored"
if [[ ! -e "$SOURCE" ]]; then
  git init "$SOURCE"
  git -C "$SOURCE" remote add origin https://github.com/signalapp/libsignal
elif [[ ! -d "$SOURCE/.git" ]]; then
  echo "error: $SOURCE exists but is not a git checkout" >&2
  exit 1
fi

if ! git -C "$SOURCE" remote get-url origin >/dev/null 2>&1; then
  git -C "$SOURCE" remote add origin https://github.com/signalapp/libsignal
fi

fetched=false
for attempt in 1 2 3; do
  if git -C "$SOURCE" fetch --depth 1 origin "$REF"; then
    fetched=true
    break
  fi
  echo "libsignal fetch attempt $attempt failed; retrying..." >&2
  sleep 15
done

if [[ "$fetched" != "true" ]]; then
  echo "error: could not fetch libsignal $REF" >&2
  exit 1
fi

git -C "$SOURCE" checkout --detach FETCH_HEAD

case "$MODE" in
  host)
    (cd "$SOURCE" && RUSTUP_TOOLCHAIN=stable ./swift/build_ffi.sh -r)
    ;;
  ios-sim)
    rustup target add --toolchain stable "$TARGET"
    (
      cd "$SOURCE"
      RUSTUP_TOOLCHAIN=stable \
        CARGO_BUILD_TARGET="$TARGET" \
        BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios16.0-simulator" \
        ./swift/build_ffi.sh -r
    )
    ;;
  ios-device)
    rustup target add --toolchain stable "$TARGET"
    (
      cd "$SOURCE"
      RUSTUP_TOOLCHAIN=stable \
        CARGO_BUILD_TARGET="$TARGET" \
        BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios16.0" \
        ./swift/build_ffi.sh -r
    )
    ;;
esac

test -f "$ARCHIVE" || {
  echo "error: libsignal build did not produce $ARCHIVE" >&2
  exit 1
}
