#!/usr/bin/env bash
# Builds the kisui that the GUI ships with (Tauri's externalBin) into
# ui/gui/app/src-tauri/binaries/kisui-<target triple>.
#
#   packaging/gui/build-kisui.sh VERSION [macos]
#
# VERSION is the GUI's version: X.Y.Z, or X.Y.Z-nightly.<yyyymmdd>.<sha> for a
# nightly. kisui gets the same version, commit and channel as packaging/npm/pack.sh
# gives it, so the GUI and its kisui always match. Without "macos" it builds for
# the CPU this machine runs on (Linux). With "macos" it builds both macOS CPUs
# and joins them with lipo (the universal build Tauri asks for needs all three).
# Needs go (and lipo for macos).
set -euo pipefail

version="${1:?usage: packaging/gui/build-kisui.sh VERSION [macos]}"
mode="${2:-}"
channel=""
if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-nightly\.[0-9]{8}\.[0-9a-f]+$ ]]; then
  channel="nightly"
  base_version="${BASH_REMATCH[1]}"
elif [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  base_version="$version"
else
  echo "error: VERSION must be X.Y.Z or X.Y.Z-nightly.<yyyymmdd>.<sha>, got $version" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/ui/gui/app/src-tauri/binaries"
mkdir -p "$out"

commit="$(git -C "$root" rev-parse --short HEAD)"
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  commit="$commit-dirty"
fi
ldflags="-s -w"
ldflags+=" -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Version=$base_version"
ldflags+=" -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Commit=$commit"
ldflags+=" -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Channel=$channel"

build() { # <GOOS> <GOARCH> <target triple>
  (cd "$root" && GOOS="$1" GOARCH="$2" CGO_ENABLED=0 \
    go build -trimpath -ldflags "$ldflags" -o "$out/kisui-$3" ./cmd/kisui)
}

if [ "$mode" = macos ]; then
  build darwin arm64 aarch64-apple-darwin
  build darwin amd64 x86_64-apple-darwin
  lipo -create -output "$out/kisui-universal-apple-darwin" \
    "$out/kisui-aarch64-apple-darwin" "$out/kisui-x86_64-apple-darwin"
else
  case "$(uname -m)" in
    x86_64) build linux amd64 x86_64-unknown-linux-gnu ;;
    aarch64 | arm64) build linux arm64 aarch64-unknown-linux-gnu ;;
    *)
      echo "error: unsupported CPU $(uname -m)" >&2
      exit 1
      ;;
  esac
fi
ls -l "$out"
