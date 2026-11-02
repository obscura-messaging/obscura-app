#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
    echo "error: release builds must be started on main" >&2
    exit 1
fi

for actor in "${GITHUB_ACTOR:-}" "${GITHUB_TRIGGERING_ACTOR:-}"; do
    if [[ "$actor" != "barrelmaker97" && "$actor" != "rhelsing" ]]; then
        echo "error: only Obscura owners can start or rerun release builds" >&2
        exit 1
    fi
done

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
build_number=$((1000 + GITHUB_RUN_NUMBER))
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
