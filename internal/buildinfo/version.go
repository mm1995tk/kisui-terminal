package buildinfo

import (
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
)

// Version and Commit are set at build time with
// -ldflags "-X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Version=... -X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Commit=...".
// The channel (stable or nightly) is Channel, set the same way.
var Version, Commit = "", ""

// Label is the build's version as shown on the status line, such as
// "v0.1 (be64521)", or "v0.1-nightly (be64521)" on the nightly channel.
// Values missing from ldflags come from the build info: the module version
// recorded by go install and the commit recorded by go build.
func Label() string {
	return formatVersion(Resolve())
}

// Resolve is the version and commit of this build before they are
// formatted for the status line. Either may be empty.
func Resolve() (version, commit string) {
	v, c := Version, Commit
	if bi, ok := debug.ReadBuildInfo(); ok {
		if v == "" && bi.Main.Version != "(devel)" {
			v = bi.Main.Version
		}
		if c == "" {
			c = buildSetting(bi, "vcs.revision")
			if c != "" && buildSetting(bi, "vcs.modified") == "true" {
				c += "-dirty"
			}
		}
	}
	return v, c
}

func buildSetting(bi *debug.BuildInfo, key string) string {
	for _, s := range bi.Settings {
		if s.Key == key {
			return s.Value
		}
	}
	return ""
}

// pseudoVersion matches the tail go install gives an untagged commit, such as
// the "-0.20261018160725-a2c02cb46b0c" in "v0.2.1-0.20261018160725-a2c02cb46b0c".
var pseudoVersion = regexp.MustCompile(`(-0\.|\.0\.|-)\d{14}-([0-9a-f]{12})$`)

func formatVersion(v, commit string) string {
	return formatChannelVersion(v, commit, Channel)
}

// formatChannelVersion is formatVersion for the given channel. A channel
// name is appended to the version, as in "v0.1-nightly (be64521)".
func formatChannelVersion(v, commit, ch string) string {
	// A pseudo-version names a commit after the latest tag, so it is shown as
	// that tag plus "+", such as "v0.2.0+ (a2c02cb)".
	if m := pseudoVersion.FindStringSubmatch(v); m != nil {
		if commit == "" {
			commit = m[2]
		}
		v = latestTag(strings.TrimSuffix(v, m[0]), m[1])
		if v != "" {
			v += "+"
		}
	}
	label := "dev"
	if v != "" {
		label = "v" + strings.TrimPrefix(v, "v")
	}
	if ch != "" {
		label += "-" + ch
	}
	if commit == "" {
		return label
	}
	hash, dirty := strings.CutSuffix(commit, "-dirty")
	if len(hash) > 7 {
		hash = hash[:7]
	}
	if dirty {
		hash += "-dirty"
	}
	return label + " (" + hash + ")"
}

// latestTag returns the tag a pseudo-version was made from, given the part
// before its timestamp and the separator in front of the timestamp.
// "v0.2.1" with "-0." comes from v0.2.0, "v1.0.0-rc.1" with ".0." from
// v1.0.0-rc.1, and a "-" means no tag came before.
func latestTag(base, sep string) string {
	switch sep {
	case ".0.":
		return base
	case "-0.":
		i := strings.LastIndex(base, ".")
		patch, err := strconv.Atoi(base[i+1:])
		if i < 0 || err != nil || patch == 0 {
			return ""
		}
		return base[:i+1] + strconv.Itoa(patch-1)
	}
	return ""
}
