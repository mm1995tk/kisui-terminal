package main

import (
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

func TestParseRead(t *testing.T) {
	for _, tc := range []struct {
		args   []string
		target string
		lines  int
		ok     bool
	}{
		{[]string{"foo"}, "foo", 0, true},
		{[]string{"foo", "--lines", "200"}, "foo", 200, true},
		{[]string{"--lines=5", "t3"}, "t3", 5, true},
		{[]string{"--lines", "0", "--", "-x"}, "-x", 0, true},
		{nil, "", 0, false},
		{[]string{""}, "", 0, false},
		{[]string{"foo", "bar"}, "", 0, false},
		{[]string{"foo", "--lines"}, "", 0, false},
		{[]string{"foo", "--lines", "-1"}, "", 0, false},
		{[]string{"foo", "--lines", "x"}, "", 0, false},
		{[]string{"foo", "--lines=1", "--lines=2"}, "", 0, false},
		{[]string{"foo", "--json"}, "", 0, false},
		{[]string{"--", "a", "b"}, "", 0, false},
	} {
		target, lines, ok := parseRead(tc.args)
		if ok != tc.ok || (ok && (target != tc.target || lines != tc.lines)) {
			t.Errorf("parseRead(%q) = %q %d %v, want %q %d %v", tc.args, target, lines, ok, tc.target, tc.lines, tc.ok)
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
