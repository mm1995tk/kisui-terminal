#!/usr/bin/env bash
# Builds the kisui that the GUI installs on a remote machine over ssh
# (app/src-tauri/src/install.rs), puts it with the shj it ships with into OUT_DIR, and
# writes a SHA256SUMS of them. They are attached to the GUI's Release.
#
#   packaging/build-remote.sh VERSION SHJ_DIR OUT_DIR
#
# VERSION and SHJ_DIR are the same as for build-kisui.sh. The files are kisui-<os>-<cpu>
# and shj-<os>-<cpu> (kisui-nightly-<os>-<cpu> and shj-nightly-<os>-<cpu> for a nightly)
# for linux and darwin on x64 and arm64. Needs go and sha256sum.
set -euo pipefail

usage="usage: packaging/build-remote.sh VERSION SHJ_DIR OUT_DIR"
version="${1:?$usage}"
shj_dir="${2:?$usage}"
out="${3:?$usage}"

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=packaging/ldflags.sh
source "$root/packaging/ldflags.sh"
kisui_ldflags="$(ldflags "$version")"

prefix=""
if [[ "$version" == *-nightly.* ]]; then
  prefix="nightly-"
fi

mkdir -p "$out"
for goos in linux darwin; do
  for goarch in amd64 arm64; do
    cpu="x64"
    if [ "$goarch" = arm64 ]; then cpu="arm64"; fi
    (cd "$root" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags "$kisui_ldflags" -o "$out/kisui-$prefix$goos-$cpu" ./cmd/kisui)
    name="$(shj_name "$version" "$goos" "$cpu")"
    cp "$shj_dir/$name" "$out/$name"
  done
done
# install.rs reads this to check a downloaded file (sha256sum's format)
(cd "$out" && sha256sum kisui-* shj-* > SHA256SUMS)
ls -l "$out"
