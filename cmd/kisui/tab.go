package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui tab": the tabs of the window (terminal tabs, browser tabs and
// database tabs), which the window owns. Each command asks the window
// (window.go). <tab> is the id of a tab ("kisui tab list" prints it) or its
// name; a name that two tabs have is refused, with the ids to use instead.

// tabInfo is one tab in the answer to "tab.list". "kisui tab list --json"
// prints these as they are, so the names of the fields are what an agent reads.
type tabInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind is "terminal", "browser" or "database".
	Kind string `json:"kind"`
	// Workspace and WorkspaceName are the id and the name of the workspace of
	// the window that holds the tab ("--workspace" takes either).
	Workspace     string `json:"workspace"`
	WorkspaceName string `json:"workspaceName"`
	// Machine is the machine of a terminal tab, by the name "--machine" takes
	// ("local" is the computer the window runs on). A browser tab and a
	// database tab are tabs of "local".
	Machine string `json:"machine"`
	// Shown is the tab its workspace shows now.
	Shown bool `json:"shown,omitempty"`
	// Self is the terminal tab of the pane that asked.
	Self bool `json:"self,omitempty"`
}

// runTabList is "kisui tab list [--json] [--workspace <name|id>]": the tabs of
// the window that the pane may reach, of every workspace (with --workspace, of
// that one), in the order of the sidebar.
func runTabList(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("tab.list.usage"))
		return 0
	}
	f, ok := parseFlags(args, []string{"--workspace"}, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("tab.list.usage"))
		return 2
	}
	rq := map[string]any{}
	if ws, ok := f.value["--workspace"]; ok {
		rq["workspace"] = ws
	}
	var out struct {
		Tabs []tabInfo `json:"tabs"`
	}
	if code := windowRun("tab list", "tab.list", rq, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		err = writeTabListJSON(os.Stdout, out.Tabs)
	} else {
		err = writeTabList(os.Stdout, out.Tabs)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("tab list", err))
		return 1
	}
	return 0
}

// writeTabListJSON writes the tabs as {"tabs": [...]}, an empty list as [].
func writeTabListJSON(w io.Writer, tabs []tabInfo) error {
	if tabs == nil {
		tabs = []tabInfo{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Tabs []tabInfo `json:"tabs"`
	}{tabs})
}

// writeTabList writes the tabs as a table for a person: one line each, with a
// "*" in front of the tab of the pane it runs in. Empty columns are "-".
func writeTabList(w io.Writer, tabs []tabInfo) error {
	rows := [][]string{append([]string{" "}, strings.Split(i18n.T("tab.list.header"), "\t")...)}
	for _, t := range tabs {
		mark := " "
		if t.Self {
			mark = "*"
		}
		note := ""
		if t.Shown {
			note = i18n.T("tab.list.shown")
		}
		rows = append(rows, []string{mark, tableCell(t.ID), tableCell(t.Name), tableCell(t.Kind), tableCell(t.Workspace + " " + t.WorkspaceName), tableCell(t.Machine), tableCell(note)})
	}
	_, err := io.WriteString(w, alignColumns(rows, 1))
	return err
}

// runTabRename is "kisui tab rename <tab> <name>": give the tab the name. An
// empty name gives back its automatic name (the folder of a terminal tab, the
// title of the page of a browser tab, the connection of a database tab).
func runTabRename(args []string) int {
	return runTabTo(args, "rename", "tab.rename", nil, 2, func(rq map[string]any, f flags) bool {
		rq["name"] = f.rest[1]
		return true
	})
}

// runTabClose is "kisui tab close [--force] <tab>": close the tab. A terminal
// tab with a running program is refused, and closed with --force (the window
// does not ask).
func runTabClose(args []string) int {
	return runTabTo(args, "close", "tab.close", []string{"--force"}, 1, func(rq map[string]any, f flags) bool {
		if f.on["--force"] {
			rq["force"] = true
		}
		return true
	})
}

// runTabShow is "kisui tab show <tab>": show the tab in the window (move to
// its workspace and turn the keys to it).
func runTabShow(args []string) int {
	return runTabTo(args, "show", "tab.show", nil, 1, func(map[string]any, flags) bool { return true })
}

// runTabMove is "kisui tab move <tab> --up|--down" (one place up or down in
// its workspace) and "kisui tab move <tab> --workspace <name|id>" (to the end
// of that workspace; the window moves there and shows the tab, as the key
// does).
func runTabMove(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("tab.move.usage"))
		return 0
	}
	f, ok := parseFlags(args, []string{"--workspace"}, []string{"--up", "--down"})
	ws, toWs := f.value["--workspace"]
	ways := 0
	for _, on := range []bool{toWs, f.on["--up"], f.on["--down"]} {
		if on {
			ways++
		}
	}
	if !ok || len(f.rest) != 1 || f.rest[0] == "" || ways != 1 {
		fmt.Fprintln(os.Stderr, i18n.T("tab.move.usage"))
		return 2
	}
	if toWs {
		return windowRun("tab move", "tab.moveTo", map[string]any{"tab": f.rest[0], "workspace": ws}, nil)
	}
	dir := "down"
	if f.on["--up"] {
		dir = "up"
	}
	var out struct {
		Moved bool `json:"moved"`
	}
	if code := windowRun("tab move", "tab.move", map[string]any{"tab": f.rest[0], "dir": dir}, &out); code != 0 {
		return code
	}
	if !out.Moved { // the key does nothing at the end of the list either
		fmt.Fprintln(os.Stderr, i18n.T("tab.move.edge"))
	}
	return 0
}

// runTabTo runs a "kisui tab <cmd> <tab> ..." that acts on one tab: args has
// words plain words (the first is the tab) and at most the flags of toggle,
// and fill puts the rest in the request (false: the usage). It returns the
// process exit code.
func runTabTo(args []string, cmd, command string, toggle []string, words int, fill func(rq map[string]any, f flags) bool) int {
	usage := i18n.T("tab." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, toggle)
	if !ok || len(f.rest) != words || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"tab": f.rest[0]}
	if !fill(rq, f) {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	return windowRun("tab "+cmd, command, rq, nil)
}
