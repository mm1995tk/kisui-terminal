package main

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
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
	for _, want := range []string{"kisui serve", "kisui attach", "kisui open <file|url>", "kisui notify <text>", "kisui clipboard copy", "kisui clipboard paste", "kisui pane send [--machine <machine>] <name|id> <text>", "kisui pane keys [--machine <machine>] <name|id> <key>...", "kisui pane close [--machine <machine>] <name|id>"} {
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
		{ID: "t1", Workspace: "gabcdefghij", WorkspaceName: "作業用", Tab: "w1", TabName: "repo", Cwd: "/src/repo", Primary: true, Alive: true, Self: true},
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
	// ワークスペース（窓が知らせた id と名前）はタブの前の列。知らされていなければ "-"
	if !strings.Contains(lines[1], "gabcdefghij 作業用  w1 repo") || !strings.Contains(lines[2], "reviewer  -") {
		t.Errorf("the workspace column:\n%s", b.String())
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

// The columns line up by the width on the screen, also with wide characters.
func TestWritePaneListWide(t *testing.T) {
	panes := []panecmd.PaneInfo{
		{ID: "t1", Name: "日本語", Tab: "w1", Cwd: "/a", Alive: true},
		{ID: "t2", Name: "ab", Tab: "w1", Cwd: "/b", Alive: true},
	}
	var b strings.Builder
	if err := writePaneList(&b, panes); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	col := func(line, s string) int { return ansi.StringWidth(line[:strings.Index(line, s)]) }
	if col(lines[1], "w1") != col(lines[2], "w1") {
		t.Errorf("the tab column is not lined up:\n%s", b.String())
	}
}

func TestAlignColumns(t *testing.T) {
	got := alignColumns([][]string{{"*", "t1", "日本", "x "}, {" ", "t10", "ab", "y"}}, 1)
	want := "* t1   日本  x\n  t10  ab    y\n"
	if got != want {
		t.Errorf("alignColumns =\n%q, want\n%q", got, want)
	}
}

// An emoji with a variation selector (U+2764 U+FE0F) takes two columns on the
// screen: the width is that of the terminal, not one column per base character.
func TestAlignColumnsEmojiPresentation(t *testing.T) {
	got := alignColumns([][]string{{"❤️", "x"}, {"abc", "y"}})
	want := "❤️   x\nabc  y\n"
	if got != want {
		t.Errorf("alignColumns =\n%q, want\n%q", got, want)
	}
}

// send, keys and close need the pane and the right number of words: a wrong
// number is a usage error (2) before asking anything, the right one outside a
// pane is an error (1).
func TestPaneToArgs(t *testing.T) {
	t.Setenv(panecmd.EnvSocket, "")
	for _, c := range []struct {
		run  func([]string) int
		args []string
		want int
	}{
		{runPaneSend, nil, 2},
		{runPaneSend, []string{"foo"}, 2},
		{runPaneSend, []string{"foo", "a", "b"}, 2},
		{runPaneSend, []string{"", "a"}, 2},
		{runPaneSend, []string{"foo", "echo hi"}, 1},
		{runPaneKeys, []string{"foo"}, 2},
		{runPaneKeys, []string{"foo", "esc", "ctrl+c"}, 1},
		{runPaneClose, nil, 2},
		{runPaneClose, []string{"foo", "bar"}, 2},
		{runPaneClose, []string{"foo"}, 1},
	} {
		if got := c.run(c.args); got != c.want {
			t.Errorf("%q: %d, want %d", c.args, got, c.want)
		}
	}
}

func TestParseList(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		asJSON  bool
		machine string
		ok      bool
	}{
		{nil, false, "", true},
		{[]string{"--json"}, true, "", true},
		{[]string{"--machine", "dev"}, false, "dev", true},
		{[]string{"--machine=local", "--json"}, true, "local", true},
		{[]string{"--json", "--json"}, false, "", false},
		{[]string{"--machine"}, false, "", false},
		{[]string{"--machine", " "}, false, "", false},
		{[]string{"--machine", "a", "--machine", "b"}, false, "", false},
		{[]string{"x"}, false, "", false},
	} {
		asJSON, machine, ok := parseList(tc.args)
		if ok != tc.ok || (ok && (asJSON != tc.asJSON || machine != tc.machine)) {
			t.Errorf("parseList(%q) = %v %q %v, want %v %q %v", tc.args, asJSON, machine, ok, tc.asJSON, tc.machine, tc.ok)
		}
	}
}
