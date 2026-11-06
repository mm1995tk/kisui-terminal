// Package buildinfo is what the build says about this binary: its version,
// its commit and its release channel, all set with ldflags. The stable shj and
// the nightly shj-nightly are the same program; the channel only changes the
// names that keep the two apart when both are installed: the user's
// configuration directory, the socket directory, the version label and the
// defaults of the [experimental] settings.
//
// Only the UI side reads this package. The core and the configuration do not
// import it; the UI passes them the values they need.
package buildinfo

import "testing"

// Channel is set at build time with
// -ldflags "-X github.com/mm1995tk/kisui-terminal/internal/buildinfo.Channel=nightly".
// Empty means the stable channel.
var Channel = ""

// Nightly is the name of the nightly channel.
const Nightly = "nightly"

// IsNightly reports whether this is a nightly build.
func IsNightly() bool { return Channel == Nightly }

// Suffix returns "-" followed by the channel name, such as "-nightly", or ""
// on the stable channel. It is appended to names shared with the stable
// build, such as "shijimi-editor" + Suffix() for the configuration directory.
func Suffix() string {
	if Channel == "" {
		return ""
	}
	return "-" + Channel
}

// SetForTest makes the rest of a test run as a build of channel ch and
// restores the real channel when the test ends.
func SetForTest(t testing.TB, ch string) {
	t.Helper()
	old := Channel
	Channel = ch
	t.Cleanup(func() { Channel = old })
}
