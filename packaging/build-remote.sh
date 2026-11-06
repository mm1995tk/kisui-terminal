#!/usr/bin/env bash
# Builds the kisui and the shj that the GUI installs on a remote machine over ssh
# (ui/gui/app/src-tauri/src/install.rs) into OUT_DIR, with a SHA256SUMS of them.
# They are attached to the GUI's Release (#581), not to shj's.
#
#   packaging/gui/build-remote.sh GUI_VERSION SHJ_VERSION OUT_DIR
#
# The versions are the same as for build-kisui.sh. The files are kisui-<os>-<cpu> and
# shj-<os>-<cpu> (kisui-nightly-<os>-<cpu> and shj-nightly-<os>-<cpu> for a nightly)
# for linux and darwin on x64 and arm64. Needs go and sha256sum.
set -euo pipefail

usage="usage: packaging/gui/build-remote.sh GUI_VERSION SHJ_VERSION OUT_DIR"
gui_version="${1:?$usage}"
shj_version="${2:?$usage}"
out="${3:?$usage}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=packaging/gui/ldflags.sh
source "$root/packaging/gui/ldflags.sh"
kisui_ldflags="$(ldflags "$gui_version")"
shj_ldflags="$(ldflags "$shj_version")"

prefix=""
if [[ "$gui_version" == *-nightly.* ]]; then
  prefix="nightly-"
fi

mkdir -p "$out"
for goos in linux darwin; do
  for goarch in amd64 arm64; do
    cpu="x64"
    if [ "$goarch" = arm64 ]; then cpu="arm64"; fi
    (cd "$root" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags "$kisui_ldflags" -o "$out/kisui-$prefix$goos-$cpu" ./cmd/kisui)
    (cd "$root" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags "$shj_ldflags" -o "$out/shj-$prefix$goos-$cpu" ./cmd/shj)
  done
done
# install.rs reads this to check a downloaded file (sha256sum's format)
(cd "$out" && sha256sum kisui-* shj-* > SHA256SUMS)
ls -l "$out"
