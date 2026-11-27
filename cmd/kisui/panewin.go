package main

import (
	"fmt"
	"maps"
	"os"
	"strconv"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui pane focus|swap|zoom|resize": what the window does to the panes of its
// terminal tabs (where the keys go, where a pane sits, which panes are shown,
// how big they are). The window owns those, so each command asks the window
// (window.go). The pane is pointed at as in "kisui pane send" (a name or an id;
// --machine for another machine).

// paneDirs are the flags that name a direction.
var paneDirs = []string{"--right", "--down", "--left", "--up"}

// paneDirOf is the direction ("right", "down", "left" or "up") that args chose
// among paneDirs (ok is false when none or more than one is on).
func paneDirOf(f flags) (dir string, ok bool) {
	for _, d := range paneDirs {
		if f.on[d] {
			if dir != "" {
				return "", false
			}
			dir = d[2:]
		}
	}
	return dir, dir != ""
}

// maxResizeSteps is the most steps "kisui pane resize" takes in one command (50
// steps of 2% are the whole width of the split).
const maxResizeSteps = 50

// runPaneFocus is "kisui pane focus [--machine <machine>] <name|id>" and
// "kisui pane focus --last": the window shows the tab of the pane and turns the
// keys to the pane; with --last, it turns them to the pane that had them before
// in the tab of the pane that asks (the key "Go to the previous pane").
func runPaneFocus(args []string) int {
	usage := i18n.T("pane.focus.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--machine"}, []string{"--last"})
	_, hasMachine := f.value["--machine"]
	last := f.on["--last"]
	if !ok || (last && (hasMachine || len(f.rest) != 0)) || (!last && (len(f.rest) != 1 || f.rest[0] == "")) {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	if last {
		var out struct {
			Moved bool `json:"moved"`
		}
		if code := windowRun("pane focus", "pane.last", nil, &out); code != 0 {
			return code
		}
		if !out.Moved { // the key does nothing either
			fmt.Fprintln(os.Stderr, i18n.T("pane.focus.nolast"))
		}
		return 0
	}
	return windowRun("pane focus", "pane.focus", paneArgs(f, nil), nil)
}

// runPaneSwap is "kisui pane swap [--machine <machine>] <name|id>
// --right|--down|--left|--up": the pane and its neighbor in that direction
// change places. The keys stay in the pane they were in.
func runPaneSwap(args []string) int {
	usage := i18n.T("pane.swap.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--machine"}, paneDirs)
	dir, dirOK := paneDirOf(f)
	if !ok || !dirOK || len(f.rest) != 1 || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		Moved bool `json:"moved"`
	}
	if code := windowRun("pane swap", "pane.swap", paneArgs(f, map[string]any{"dir": dir}), &out); code != 0 {
		return code
	}
	if !out.Moved { // the key does nothing either
		fmt.Fprintln(os.Stderr, i18n.T("pane.swap.edge"))
	}
	return 0
}

// runPaneZoom is "kisui pane zoom [--machine <machine>] <name|id>": show only
// the primary pane of the tab of the pane, or show all the panes again (it
// toggles, as the key does).
func runPaneZoom(args []string) int {
	usage := i18n.T("pane.zoom.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--machine"}, nil)
	if !ok || len(f.rest) != 1 || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	return windowRun("pane zoom", "pane.zoom", paneArgs(f, nil), nil)
}

// runPaneResize is "kisui pane resize [--machine <machine>] <name|id>
// --right|--down|--left|--up <n>": move the border of the pane that faces that
// direction n steps that way, a step being what one key of the resize mode
// moves (2% of the split).
func runPaneResize(args []string) int {
	usage := i18n.T("pane.resize.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--machine"}, paneDirs)
	dir, dirOK := paneDirOf(f)
	n := 0
	if ok && len(f.rest) == 2 {
		n, _ = strconv.Atoi(f.rest[1])
	}
	if !ok || !dirOK || len(f.rest) != 2 || f.rest[0] == "" || n < 1 || n > maxResizeSteps || strconv.Itoa(n) != f.rest[1] {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		Moved bool `json:"moved"`
	}
	if code := windowRun("pane resize", "pane.resize", paneArgs(f, map[string]any{"dir": dir, "steps": n}), &out); code != 0 {
		return code
	}
	if !out.Moved { // the key does nothing either
		fmt.Fprintln(os.Stderr, i18n.T("pane.resize.edge"))
	}
	return 0
}

// paneArgs is the arguments for the window of a command on a pane: the pane (the
// first plain word), the machine when --machine is given, and extra.
func paneArgs(f flags, extra map[string]any) map[string]any {
	rq := map[string]any{}
	if len(f.rest) > 0 {
		rq["pane"] = f.rest[0]
	}
	if m, ok := f.value["--machine"]; ok {
		rq["machine"] = m
	}
	maps.Copy(rq, extra)
	return rq
}
