package main

import (
	"slices"
	"testing"
)

func TestParseOpen(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want open
		ok   bool
	}{
		{[]string{"--workspace", "review", "--name", "reviewer", "--", "claude"}, open{workspace: "review", name: "reviewer", argv: []string{"claude"}}, true},
		{[]string{"--workspace=a b", "--new", "--name=r", "--cwd", "/src", "htop", "-x"}, open{workspace: "a b", name: "r", cwd: "/src", new: true, argv: []string{"htop", "-x"}}, true},
		{[]string{"--name", "r", "--workspace", "w"}, open{workspace: "w", name: "r"}, true},
		{[]string{"--workspace", "w", "--name", "r", "claude", "--name", "x"}, open{workspace: "w", name: "r", argv: []string{"claude", "--name", "x"}}, true},
		{[]string{"--workspace", "w", "--name", "r", "--"}, open{workspace: "w", name: "r"}, true},
		{[]string{"--workspace", "w"}, open{}, false},
		{[]string{"--name", "r"}, open{}, false},
		{[]string{"--workspace", "w", "--name"}, open{}, false},
		{[]string{"--workspace", " ", "--name", "r"}, open{}, false},
		{[]string{"--workspace", "w", "--workspace", "v", "--name", "r"}, open{}, false},
		{[]string{"--workspace", "w", "--name", "r", "--new", "--new"}, open{}, false},
		{[]string{"--workspace", "w", "--name", "r", "--new=yes"}, open{}, false},
		{[]string{"--workspace", "w", "--name", "r", "--machine", "dev", "/bin/sh"}, open{workspace: "w", name: "r", machine: "dev", argv: []string{"/bin/sh"}}, true},
		{[]string{"--machine=", "--workspace", "w", "--name", "r"}, open{}, false},
		{[]string{"--workspace", "w", "--name", "r", "--machine", "a", "--machine", "b"}, open{}, false},
		{[]string{"--workspace", "w", "--name", "r", "--bogus"}, open{}, false},
	} {
		op, ok := parseOpen(tc.args)
		if ok != tc.ok || (ok && (op.workspace != tc.want.workspace || op.name != tc.want.name || op.cwd != tc.want.cwd || op.new != tc.want.new || op.machine != tc.want.machine || !slices.Equal(op.argv, tc.want.argv))) {
			t.Errorf("parseOpen(%q) = %+v %v, want %+v %v", tc.args, op, ok, tc.want, tc.ok)
		}
	}
}
