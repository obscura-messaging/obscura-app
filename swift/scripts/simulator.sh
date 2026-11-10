#!/usr/bin/env bash
#
# Prints the id of an available iPhone simulator on the newest iOS runtime, compared by version
# number. The kit's tests run there: libsignal's prebuilt core has iOS slices only.
#
set -euo pipefail

id="$(xcrun simctl list --json devices available iPhone | python3 -c 'import json, re, sys
runtimes = {key: devices for key, devices in json.load(sys.stdin)["devices"].items() if devices}
version = lambda key: [int(n) for n in re.findall(r"\d+", key.rsplit(".", 1)[-1])]
if runtimes:
    print(runtimes[max(runtimes, key=version)][0]["udid"])')"
[[ -n "$id" ]] || { echo "error: no iPhone simulator available" >&2; exit 1; }
echo "$id"
