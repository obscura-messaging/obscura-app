#!/usr/bin/env bash
# Install the stable Rust toolchain on a GitHub Actions runner, plus any
# targets passed as arguments. Runner images ship rustup; this installs it
# only when an image does not.
#
# Usage: scripts/ci-install-rust.sh [TARGET...]
set -euo pipefail

if ! command -v rustup >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
        sh -s -- -y --profile minimal --default-toolchain none
    export PATH="$HOME/.cargo/bin:$PATH"
    if [[ -n "${GITHUB_PATH:-}" ]]; then
        echo "$HOME/.cargo/bin" >>"$GITHUB_PATH"
    fi
fi

rustup toolchain install stable --profile minimal --no-self-update
rustup default stable
if [[ $# -gt 0 ]]; then
    rustup target add --toolchain stable "$@"
fi
rustc --version
