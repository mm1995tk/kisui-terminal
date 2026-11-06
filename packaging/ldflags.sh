# Sourced by build-kisui.sh and build-remote.sh. Not run on its own.
#
# ldflags VERSION: the go build -ldflags for a binary of VERSION, which is X.Y.Z, or
# X.Y.Z-nightly.<yyyymmdd>.<sha> for a nightly (the same as packaging/npm/pack.sh gives it).
# $root is the root of the repository.
ldflags() {
  local version="$1" channel="" base_version commit
  if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-nightly\.[0-9]{8}\.[0-9a-f]+$ ]]; then
    channel="nightly"
    base_version="${BASH_REMATCH[1]}"
  elif [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    base_version="$version"
  else
    echo "error: version must be X.Y.Z or X.Y.Z-nightly.<yyyymmdd>.<sha>, got $version" >&2
    return 1
  fi
  commit="$(git -C "$root" rev-parse --short HEAD)"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    commit="$commit-dirty"
  fi
  printf '%s' "-s -w -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Version=$base_version -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Commit=$commit -X github.com/mm1995tk/shijimi-editor/ui/internal/buildinfo.Channel=$channel"
}
