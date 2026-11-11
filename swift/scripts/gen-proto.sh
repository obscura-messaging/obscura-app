#!/usr/bin/env bash
#
# Generates the Swift protobuf bindings into Sources/ObscuraKit/Proto (not committed) from the
# canonical protos: the client protocol in client-protocol/ and the transport in the server-proto/ submodule.
#
# The generator is protoc-gen-swift built from the SwiftProtobuf version swift/Package.resolved pins,
# so the generated code always matches the runtime the kit links; the iOS app's pin must agree.
# protoc only parses the protos, so any recent one does: brew install protobuf.
#
set -euo pipefail

cd "$(dirname "$0")/.."

command -v protoc >/dev/null || { echo "error: protoc not found (brew install protobuf)" >&2; exit 1; }
[[ -f ../client-protocol/obscura/client/v1/client.proto ]] || { echo "error: the client protocol is missing" >&2; exit 1; }
[[ -f ../server-proto/obscura/v1/obscura.proto ]] || {
  echo "error: the transport submodule is not checked out; run: git submodule update --init" >&2
  exit 1
}

pin() {
  python3 -c 'import json, sys
pins = {p["identity"]: p["state"]["version"] for p in json.load(open(sys.argv[1]))["pins"]}
print(pins["swift-protobuf"])' "$1"
}
version="$(pin Package.resolved)"
app_version="$(pin ../ios/Obscura.xcworkspace/xcshareddata/swiftpm/Package.resolved)"
if [[ "$version" != "$app_version" ]]; then
  echo "error: SwiftProtobuf is $version for the kit but $app_version for the iOS app; pin both to one version" >&2
  exit 1
fi

tools=".build/tools/swift-protobuf-$version"
plugin="$tools/.build/release/protoc-gen-swift"
if [[ ! -x "$plugin" ]]; then
  rm -rf "$tools"
  git clone --quiet --depth 1 --branch "$version" https://github.com/apple/swift-protobuf.git "$tools"
  xcrun swift build --configuration release --package-path "$tools" --product protoc-gen-swift
fi

out="Sources/ObscuraKit/Proto"
rm -rf "$out"
mkdir -p "$out/Client" "$out/Server"
protoc --plugin=protoc-gen-swift="$plugin" --proto_path=../client-protocol/obscura/client/v1 \
  --swift_out="$out/Client" ../client-protocol/obscura/client/v1/client.proto
protoc --plugin=protoc-gen-swift="$plugin" --proto_path=../server-proto/obscura/v1 \
  --swift_out="$out/Server" ../server-proto/obscura/v1/obscura.proto
echo "Generated Swift protobuf bindings with protoc-gen-swift $version."
