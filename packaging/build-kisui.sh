#!/usr/bin/env bash
# Builds the kisui and the shj that the GUI ships with (Tauri's externalBin) into
# ui/gui/app/src-tauri/binaries/{kisui,shj}-<target triple>. kisui puts the shj next
# to it first on the PATH of the terminals in its panes.
#
#   packaging/gui/build-kisui.sh GUI_VERSION SHJ_VERSION [macos]
#
# GUI_VERSION is the GUI's version and SHJ_VERSION is the version of the shj that
# ships with it. They are separate (#581): the GUI has its own version in
# ui/gui/app/src-tauri/Cargo.toml and shj has the version in flake.nix. Each is
# X.Y.Z, or X.Y.Z-nightly.<yyyymmdd>.<sha> for a nightly. kisui gets the GUI's version
# (it is the GUI's server); shj gets SHJ_VERSION, with the same commit and channel as
# packaging/npm/pack.sh gives it. Without "macos" it builds for the CPU this machine
# runs on (Linux). With "macos" it builds both macOS CPUs and joins them with lipo
# (the universal build Tauri asks for needs all three).
# Needs go (and lipo for macos).
set -euo pipefail

usage="usage: packaging/gui/build-kisui.sh GUI_VERSION SHJ_VERSION [macos]"
gui_version="${1:?$usage}"
shj_version="${2:?$usage}"
mode="${3:-}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=packaging/gui/ldflags.sh
source "$root/packaging/gui/ldflags.sh"
kisui_ldflags="$(ldflags "$gui_version")"
shj_ldflags="$(ldflags "$shj_version")"

out="$root/ui/gui/app/src-tauri/binaries"
mkdir -p "$out"

build() { # <GOOS> <GOARCH> <target triple>
  (cd "$root" && GOOS="$1" GOARCH="$2" CGO_ENABLED=0 \
    go build -trimpath -ldflags "$kisui_ldflags" -o "$out/kisui-$3" ./cmd/kisui)
  (cd "$root" && GOOS="$1" GOARCH="$2" CGO_ENABLED=0 \
    go build -trimpath -ldflags "$shj_ldflags" -o "$out/shj-$3" ./cmd/shj)
}

if [ "$mode" = macos ]; then
  build darwin arm64 aarch64-apple-darwin
  build darwin amd64 x86_64-apple-darwin
  for tool in kisui shj; do
    lipo -create -output "$out/$tool-universal-apple-darwin" \
      "$out/$tool-aarch64-apple-darwin" "$out/$tool-x86_64-apple-darwin"
  done
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
