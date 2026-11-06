package buildinfo

import "testing"

func TestFormatVersion(t *testing.T) {
	for _, c := range []struct{ v, commit, want string }{
		{"0.1", "", "v0.1"},
		{"v1.2.3", "", "v1.2.3"},
		{"", "", "dev"},
		{"0.1", "be64521", "v0.1 (be64521)"},
		{"0.1", "be64521e0123456789abcdef0123456789abcdef", "v0.1 (be64521)"},
		{"0.1", "be64521e0123456789abcdef0123456789abcdef-dirty", "v0.1 (be64521-dirty)"},
		{"", "be64521-dirty", "dev (be64521-dirty)"},
		{"v0.2.1-0.20261018160725-a2c02cb46b0c", "", "v0.2.0+ (a2c02cb)"},
		{"v0.2.1-0.20261018160725-a2c02cb46b0c", "a2c02cb", "v0.2.0+ (a2c02cb)"},
		{"v1.0.0-rc.1.0.20261018160725-a2c02cb46b0c", "", "v1.0.0-rc.1+ (a2c02cb)"},
		{"v0.0.0-20261018160725-a2c02cb46b0c", "", "dev (a2c02cb)"},
		{"v0.2.0", "", "v0.2.0"},
		{"0.2.0", "1dfbcec", "v0.2.0 (1dfbcec)"},
	} {
		if got := formatChannelVersion(c.v, c.commit, ""); got != c.want {
			t.Errorf("formatChannelVersion(%q, %q, \"\") = %q, want %q", c.v, c.commit, got, c.want)
		}
	}
}

func TestFormatVersionNightly(t *testing.T) {
	for _, c := range []struct{ v, commit, want string }{
		{"0.6.1", "be64521", "v0.6.1-nightly (be64521)"},
		{"0.6.1", "", "v0.6.1-nightly"},
		{"", "be64521", "dev-nightly (be64521)"},
	} {
		if got := formatChannelVersion(c.v, c.commit, "nightly"); got != c.want {
			t.Errorf("formatChannelVersion(%q, %q, \"nightly\") = %q, want %q", c.v, c.commit, got, c.want)
		}
	}
}
