package main

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
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

func TestParseSplit(t *testing.T) {
	for _, tc := range []struct {
		args []string
		dir  string
		argv []string
		ok   bool
	}{
		{[]string{"--right"}, "right", nil, true},
		{[]string{"--down", "htop"}, "down", []string{"htop"}, true},
		{[]string{"--right", "--", "ls", "--down"}, "right", []string{"ls", "--down"}, true},
		{[]string{"--down", "go", "test", "--right"}, "down", []string{"go", "test", "--right"}, true},
		{[]string{"--", "--right"}, "", nil, false},
		{nil, "", nil, false},
		{[]string{"htop"}, "", nil, false},
		{[]string{"--right", "--down"}, "", nil, false},
		{[]string{"--left"}, "left", nil, true},
		{[]string{"--up", "vim"}, "up", []string{"vim"}, true},
		{[]string{"--left", "--up"}, "", nil, false},
		{[]string{"--diagonal"}, "", nil, false},
		{[]string{"--right", "-x"}, "", nil, false},
	} {
		sp, ok := parseSplit(tc.args)
		if ok != tc.ok || (ok && (sp.dir != tc.dir || sp.name != "" || !slices.Equal(sp.argv, tc.argv))) {
			t.Errorf("parseSplit(%q) = %+v %v, want %q %q %v", tc.args, sp, ok, tc.dir, tc.argv, tc.ok)
		}
	}
}

func TestParseSplitName(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want split
		ok   bool
	}{
		{[]string{"--right", "--name", "foo"}, split{dir: "right", name: "foo"}, true},
		{[]string{"--name", "foo", "--down", "htop", "-x"}, split{dir: "down", name: "foo", argv: []string{"htop", "-x"}}, true},
		{[]string{"--name=a b", "--left", "--", "ls"}, split{dir: "left", name: "a b", argv: []string{"ls"}}, true},
		{[]string{"--right", "--name"}, split{}, false},
		{[]string{"--right", "--name", ""}, split{}, false},
		{[]string{"--right", "--name=  "}, split{}, false},
		{[]string{"--right", "--name", "a", "--name", "b"}, split{}, false},
		{[]string{"--name", "foo"}, split{}, false},
		{[]string{"--right", "htop", "--name", "foo"}, split{dir: "right", argv: []string{"htop", "--name", "foo"}}, true},
	} {
		sp, ok := parseSplit(tc.args)
		if ok != tc.ok || (ok && (sp.dir != tc.want.dir || sp.name != tc.want.name || !slices.Equal(sp.argv, tc.want.argv))) {
			t.Errorf("parseSplit(%q) = %+v %v, want %+v %v", tc.args, sp, ok, tc.want, tc.ok)
		}
	}
}

func TestWritePaneList(t *testing.T) {
	panes := []panecmd.PaneInfo{
		{ID: "t1", Tab: "w1", TabName: "repo", Cwd: "/src/repo", Primary: true, Alive: true, Self: true},
		{ID: "t2", Name: "reviewer", Tab: "w1", TabName: "repo", Cwd: "/src/repo", Title: "a\tb", Alive: false},
	}
	var b strings.Builder
	if err := writePaneList(&b, panes); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("a header and a line for each pane:\n%s", b.String())
	}
	if !strings.HasPrefix(lines[1], "* t1") || !strings.Contains(lines[1], "w1 repo") || !strings.Contains(lines[1], i18n.T("pane.list.primary")) {
		t.Errorf("the line of the own pane: %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "  t2") || !strings.Contains(lines[2], "reviewer") || !strings.Contains(lines[2], "a b") || !strings.Contains(lines[2], i18n.T("pane.list.ended")) {
		t.Errorf("the line of the named pane: %q", lines[2])
	}

	b.Reset()
	if err := writePaneListJSON(&b, nil); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Panes []panecmd.PaneInfo `json:"panes"`
	}
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil || got.Panes == nil {
		t.Fatalf("no panes must be an empty list: %q %v", b.String(), err)
	}
}
