#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

if [[ -z "$sdk" ]]; then
  case "$(uname -s)" in
    Darwin)
      [[ -d "$HOME/Library/Android/sdk" ]] && sdk="$HOME/Library/Android/sdk"
      ;;
    Linux)
      [[ -d "$HOME/Android/Sdk" ]] && sdk="$HOME/Android/Sdk"
      ;;
  esac
fi

if [[ -z "$sdk" || ! -d "$sdk/platforms/android-37.0" ]]; then
  echo "error: Android SDK 37 is required; set ANDROID_HOME" >&2
  exit 1
fi

export ANDROID_HOME="$sdk"
export ANDROID_SDK_ROOT="$sdk"

exec "$ROOT/scripts/run-with-java-21.sh" "$@"
