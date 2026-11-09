#!/usr/bin/env bash
set -euo pipefail

# Who may release, and from which branch, is enforced by the android-* and
# ios-* GitHub environments (main only, maintainer review). This checks what
# GitHub cannot: the commit is main's tip and its CI run passed.
sha="$(git rev-parse HEAD)"
if [[ "$sha" != "${GITHUB_SHA:-}" ]]; then
    echo "error: checkout does not match the selected main commit" >&2
    exit 1
fi

git fetch --no-tags origin main
if [[ "$sha" != "$(git rev-parse origin/main)" ]]; then
    echo "error: a newer main commit is available; run the release workflow again" >&2
    exit 1
fi

ci_passed="$(gh api \
    "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&per_page=30" \
    --jq '[.workflow_runs[] | select(.head_branch == "main" and .status == "completed" and .conclusion == "success")] | length')"
if [[ "$ci_passed" -lt 1 ]]; then
    echo "error: the selected main commit has no successful CI run" >&2
    exit 1
fi

if [[ ! "${GITHUB_RUN_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: invalid release workflow run number" >&2
    exit 1
fi
build_number=$((1010 + GITHUB_RUN_NUMBER))
if (( build_number > 2100000000 )); then
    echo "error: Android version code exceeds the supported limit" >&2
    exit 1
fi
if [[ ! -f package.json ]]; then
    echo "error: package.json is missing" >&2
    exit 1
fi
version="$(node -p "require('./package.json').version")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: package.json version must be X.Y.Z SemVer (found '$version')" >&2
    exit 1
fi
{
    echo "sha=$sha"
    echo "build_number=$build_number"
    echo "version=$version"
} >> "$GITHUB_OUTPUT"
