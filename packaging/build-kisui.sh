#!/usr/bin/env bash
# Builds kisui, and puts it and the shj it ships with (Tauri's externalBin) into
# app/src-tauri/binaries/{kisui,shj}-<target triple>. kisui puts the shj next to it
# first on the PATH of the terminals in its panes.
#
#   packaging/build-kisui.sh VERSION SHJ_DIR [macos]
#
# VERSION is the GUI's version (X.Y.Z, or X.Y.Z-nightly.<yyyymmdd>.<sha> for a
# nightly); kisui gets it, since it is the GUI's server. SHJ_DIR holds the shj of
# every OS and CPU as fetch-shj.sh leaves them. Without "macos" it builds for the CPU
# this machine runs on (Linux). With "macos" it builds both macOS CPUs and joins them
# with lipo (the universal build Tauri asks for needs all three), for shj too.
# Needs go (and lipo for macos).
set -euo pipefail

usage="usage: packaging/build-kisui.sh VERSION SHJ_DIR [macos]"
version="${1:?$usage}"
shj_dir="${2:?$usage}"
mode="${3:-}"

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=packaging/ldflags.sh
source "$root/packaging/ldflags.sh"
kisui_ldflags="$(ldflags "$version")"

out="$root/app/src-tauri/binaries"
mkdir -p "$out"

build() { # <GOOS> <GOARCH> <target triple>
  (cd "$root" && GOOS="$1" GOARCH="$2" CGO_ENABLED=0 \
    go build -trimpath -ldflags "$kisui_ldflags" -o "$out/kisui-$3" ./cmd/kisui)
}
shj() { # <os> <cpu> <target triple>
  local name
  name="$(shj_name "$version" "$1" "$2")"
  cp "$shj_dir/$name" "$out/shj-$3"
  chmod +x "$out/shj-$3"
}

if [ "$mode" = macos ]; then
  build darwin arm64 aarch64-apple-darwin
  build darwin amd64 x86_64-apple-darwin
  shj darwin arm64 aarch64-apple-darwin
  shj darwin x64 x86_64-apple-darwin
  for tool in kisui shj; do
    lipo -create -output "$out/$tool-universal-apple-darwin" \
      "$out/$tool-aarch64-apple-darwin" "$out/$tool-x86_64-apple-darwin"
  done
else
  case "$(uname -m)" in
    x86_64)
      build linux amd64 x86_64-unknown-linux-gnu
      shj linux x64 x86_64-unknown-linux-gnu
      ;;
    aarch64 | arm64)
      build linux arm64 aarch64-unknown-linux-gnu
      shj linux arm64 aarch64-unknown-linux-gnu
      ;;
    *)
      echo "error: unsupported CPU $(uname -m)" >&2
      exit 1
      ;;
  esac
fi
ls -l "$out"
