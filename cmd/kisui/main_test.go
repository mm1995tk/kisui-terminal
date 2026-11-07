package main

import (
	"strings"
	"testing"
)

// The help lists every command, also the ones in a group, and a group without
// a command shows its own list.
func TestDispatchAndUsage(t *testing.T) {
	ran := ""
	cmds := []command{
		{name: "open", args: "<file|url>", help: "help.open", run: func(args []string) int { ran = "open " + strings.Join(args, " "); return 0 }},
		{name: "pane", sub: []command{
			{name: "split", help: "help.open", run: func(args []string) int { ran = "pane split"; return 3 }},
		}},
	}
	var out, errOut strings.Builder
	if code := dispatch(cmds, "kisui", []string{"open", "a.png"}, &out, &errOut); code != 0 || ran != "open a.png" {
		t.Fatalf("open: %d %q", code, ran)
	}
	if code := dispatch(cmds, "kisui", []string{"pane", "split"}, &out, &errOut); code != 3 || ran != "pane split" {
		t.Fatalf("pane split: %d %q", code, ran)
	}
	if code := dispatch(cmds, "kisui", []string{"--help"}, &out, &errOut); code != 0 {
		t.Fatalf("--help: %d", code)
	}
	for _, want := range []string{"kisui open <file|url>", "kisui pane split", "kisui --version"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the help has no %q:\n%s", want, out.String())
		}
	}
	errOut.Reset()
	if code := dispatch(cmds, "kisui", []string{"pane"}, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "kisui pane split") || strings.Contains(errOut.String(), "kisui open") {
		t.Fatalf("pane without a command: %d\n%s", code, errOut.String())
	}
	if code := dispatch(cmds, "kisui", []string{"nope"}, &out, &errOut); code != 2 {
		t.Fatalf("an unknown command: %d", code)
	}
}

// The real commands are all in the help.
func TestUsageListsCommands(t *testing.T) {
	var out strings.Builder
	usage(&out, commands, "kisui")
	for _, want := range []string{"kisui serve", "kisui attach", "kisui open <file|url>", "kisui notify <text>", "kisui clipboard copy", "kisui clipboard paste"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the help has no %q:\n%s", want, out.String())
		}
	}
}
