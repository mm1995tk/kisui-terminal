package main

import (
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

func TestParseRead(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want read
		ok   bool
	}{
		{[]string{"foo"}, read{target: "foo"}, true},
		{[]string{"foo", "--lines", "200"}, read{target: "foo", lines: 200}, true},
		{[]string{"--lines=5", "t3"}, read{target: "t3", lines: 5}, true},
		{[]string{"--lines", "0", "--", "-x"}, read{target: "-x"}, true},
		{[]string{"--machine", "dev", "bar"}, read{target: "bar", machine: "dev"}, true},
		{[]string{"bar", "--machine=local", "--lines", "3"}, read{target: "bar", machine: "local", lines: 3}, true},
		{nil, read{}, false},
		{[]string{""}, read{}, false},
		{[]string{"foo", "bar"}, read{}, false},
		{[]string{"foo", "--lines"}, read{}, false},
		{[]string{"foo", "--lines", "-1"}, read{}, false},
		{[]string{"foo", "--lines", "x"}, read{}, false},
		{[]string{"foo", "--lines=1", "--lines=2"}, read{}, false},
		{[]string{"foo", "--json"}, read{}, false},
		{[]string{"--", "a", "b"}, read{}, false},
		{[]string{"foo", "--machine"}, read{}, false},
		{[]string{"foo", "--machine="}, read{}, false},
		{[]string{"foo", "--machine", "a", "--machine", "b"}, read{}, false},
	} {
		got, ok := parseRead(tc.args)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("parseRead(%q) = %+v %v, want %+v %v", tc.args, got, ok, tc.want, tc.ok)
		}
	}
}

// A wrong argument is a usage error (2) before asking anything; the right ones
// outside a pane are an error (1).
func TestRunPaneReadOutsidePane(t *testing.T) {
	t.Setenv(panecmd.EnvSocket, "")
	for _, c := range []struct {
		args []string
		want int
	}{
		{nil, 2},
		{[]string{"foo", "--lines", "-3"}, 2},
		{[]string{"foo"}, 1},
		{[]string{"foo", "--lines", "200"}, 1},
	} {
		if got := runPaneRead(c.args); got != c.want {
			t.Errorf("%q: %d, want %d", c.args, got, c.want)
		}
	}
}
