# Sourced by build-kisui.sh and build-remote.sh. Not run on its own.
#
# ldflags VERSION: the go build -ldflags for a kisui of VERSION, which is X.Y.Z, or
# X.Y.Z-nightly.<yyyymmdd>.g<sha> for a nightly (the version of the GUI; kisui is its server).
# $root is the root of the repository.
ldflags() {
  local version="$1" channel="" base_version commit
  if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-nightly\.[0-9]{8}\.g[0-9a-f]+$ ]]; then
    channel="nightly"
    base_version="${BASH_REMATCH[1]}"
  elif [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    base_version="$version"
  else
    echo "error: version must be X.Y.Z or X.Y.Z-nightly.<yyyymmdd>.g<sha>, got $version" >&2
    return 1
  fi
  commit="$(git -C "$root" rev-parse --short HEAD)"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    commit="$commit-dirty"
  fi
  printf '%s' "-s -w -X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Version=$base_version -X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Commit=$commit -X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Channel=$channel"
}

# shj_tag SHJ_VERSION: the tag of the Release of shijimi-editor that has the shj of that
# version: vX.Y.Z, or the moving pre-release nightly for X.Y.Z-nightly.<yyyymmdd>.<sha> (shijimi-editor's version, without g).
shj_tag() {
  if [[ "$1" == *-nightly.* ]]; then
    printf 'nightly'
  else
    printf 'v%s' "$1"
  fi
}

# shj_name SHJ_VERSION OS CPU: the name of the shj in that Release (and of the one
# install.rs puts on a remote machine): shj-<os>-<cpu>, or shj-nightly-<os>-<cpu>.
shj_name() {
  if [[ "$1" == *-nightly.* ]]; then
    printf 'shj-nightly-%s-%s' "$2" "$3"
  else
    printf 'shj-%s-%s' "$2" "$3"
  fi
}
