#!/usr/bin/env bash
# Downloads the shj that kisui-terminal ships with from the Release of shijimi-editor
# (https://github.com/mm1995tk/shijimi-editor/releases) into OUT_DIR, for linux and
# darwin on x64 and arm64, and checks each against the SHA256SUMS of that Release.
# kisui-terminal does not build shj: the shj it ships is the one shijimi-editor released.
#
#   packaging/fetch-shj.sh SHJ_VERSION OUT_DIR
#
# SHJ_VERSION is X.Y.Z (the Release vX.Y.Z) or X.Y.Z-nightly.<yyyymmdd>.<sha> (the
# pre-release nightly; its shj must be of that version, see nightly.yml). The files
# keep their names in the Release: shj-<os>-<cpu>, or shj-nightly-<os>-<cpu>.
# Needs curl and sha256sum.
set -euo pipefail

usage="usage: packaging/fetch-shj.sh SHJ_VERSION OUT_DIR"
shj_version="${1:?$usage}"
out="${2:?$usage}"

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=packaging/ldflags.sh
source "$root/packaging/ldflags.sh"

if [[ ! "$shj_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]{8}\.[0-9a-f]+)?$ ]]; then
  echo "error: SHJ_VERSION must be X.Y.Z or X.Y.Z-nightly.<yyyymmdd>.<sha>, got $shj_version" >&2
  exit 1
fi
base="https://github.com/mm1995tk/shijimi-editor/releases/download/$(shj_tag "$shj_version")"

mkdir -p "$out"
fetch() { # <name>
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$out/$1" "$base/$1"
}
fetch SHA256SUMS
names=()
for os in linux darwin; do
  for cpu in x64 arm64; do
    name="$(shj_name "$shj_version" "$os" "$cpu")"
    fetch "$name"
    names+=("$name")
  done
done
# Only the lines of the files taken (the Release lists kisui too, in older ones)
(cd "$out" && grep -E " (${names[0]}|${names[1]}|${names[2]}|${names[3]})\$" SHA256SUMS | sha256sum -c -)
rm "$out/SHA256SUMS"
chmod +x "$out"/shj-*
ls -l "$out"
