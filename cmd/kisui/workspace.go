package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui workspace": the workspaces of the window, which the window owns. Each
// command asks the window (window.go). <workspace> is the id of a workspace
// ("kisui workspace list" prints it) or its name; a name that two workspaces
// have is refused, with the ids to use instead. A workspace groups tabs, and
// may have none.

// workspaceInfo is one workspace in the answer to "workspace.list".
// "kisui workspace list --json" prints these as they are, so the names of the
// fields are what an agent reads.
type workspaceInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Tabs is the number of tabs in it that the pane may reach.
	Tabs int `json:"tabs"`
	// Current is the workspace the window is in now.
	Current bool `json:"current,omitempty"`
	// Self is the workspace of the terminal tab of the pane that asked.
	Self bool `json:"self,omitempty"`
}

// runWorkspaceList is "kisui workspace list [--json]": the workspaces of the
// window that the pane may reach, with the number of their tabs, in the order
// of the sidebar. A workspace with no tab is listed too.
func runWorkspaceList(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("workspace.list.usage"))
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("workspace.list.usage"))
		return 2
	}
	var out struct {
		Workspaces []workspaceInfo `json:"workspaces"`
	}
	if code := windowRun("workspace list", "workspace.list", map[string]any{}, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		err = writeWorkspaceListJSON(os.Stdout, out.Workspaces)
	} else {
		err = writeWorkspaceList(os.Stdout, out.Workspaces)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("workspace list", err))
		return 1
	}
	return 0
}

// writeWorkspaceListJSON writes the workspaces as {"workspaces": [...]}, an
// empty list as [].
func writeWorkspaceListJSON(w io.Writer, list []workspaceInfo) error {
	if list == nil {
		list = []workspaceInfo{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Workspaces []workspaceInfo `json:"workspaces"`
	}{list})
}

// writeWorkspaceList writes the workspaces as a table for a person: one line
// each, with a "*" in front of the workspace of the pane it runs in.
func writeWorkspaceList(w io.Writer, list []workspaceInfo) error {
	rows := [][]string{append([]string{" "}, strings.Split(i18n.T("workspace.list.header"), "\t")...)}
	for _, g := range list {
		mark := " "
		if g.Self {
			mark = "*"
		}
		note := ""
		if g.Current {
			note = i18n.T("workspace.list.current")
		}
		rows = append(rows, []string{mark, tableCell(g.ID), tableCell(g.Name), fmt.Sprint(g.Tabs), tableCell(note)})
	}
	_, err := io.WriteString(w, alignColumns(rows, 1))
	return err
}

// runWorkspaceNew is "kisui workspace new <name>": make a workspace with no
// tab at the end of the sidebar, as the n of the workspace switcher does (an
// empty name gives it a numbered name). The window stays where it is. It
// prints the id of the workspace.
func runWorkspaceNew(args []string) int {
	usage := i18n.T("workspace.new.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, nil)
	if !ok || len(f.rest) != 1 {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		ID string `json:"id"`
	}
	if code := windowRun("workspace new", "workspace.new", map[string]any{"name": f.rest[0]}, &out); code != 0 {
		return code
	}
	fmt.Println(out.ID)
	return 0
}

// runWorkspaceRename is "kisui workspace rename <workspace> <name>": give the
// workspace the name. An empty name gives back its numbered name.
func runWorkspaceRename(args []string) int {
	return runWorkspaceTo(args, "rename", nil, 2, func(rq map[string]any, f flags) {
		rq["name"] = f.rest[1]
	})
}

// runWorkspaceClose is "kisui workspace close [--force] <workspace>": close
// the workspace and all its tabs. One with a terminal tab that has a running
// program is refused, and closed with --force (the window does not ask).
func runWorkspaceClose(args []string) int {
	return runWorkspaceTo(args, "close", []string{"--force"}, 1, func(rq map[string]any, f flags) {
		if f.on["--force"] {
			rq["force"] = true
		}
	})
}

// runWorkspaceShow is "kisui workspace show <workspace>": go to the workspace
// in the window and turn the keys to the tab it shows.
func runWorkspaceShow(args []string) int {
	return runWorkspaceTo(args, "show", nil, 1, func(map[string]any, flags) {})
}

// runWorkspaceMove is "kisui workspace move <workspace> --up|--down": one
// place up or down in the sidebar.
func runWorkspaceMove(args []string) int {
	usage := i18n.T("workspace.move.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--up", "--down"})
	if !ok || len(f.rest) != 1 || f.rest[0] == "" || f.on["--up"] == f.on["--down"] {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	dir := "down"
	if f.on["--up"] {
		dir = "up"
	}
	var out struct {
		Moved bool `json:"moved"`
	}
	if code := windowRun("workspace move", "workspace.move", map[string]any{"workspace": f.rest[0], "dir": dir}, &out); code != 0 {
		return code
	}
	if !out.Moved { // the key does nothing at the end of the list either
		fmt.Fprintln(os.Stderr, i18n.T("workspace.move.edge"))
	}
	return 0
}

// runWorkspaceTo runs a "kisui workspace <cmd> <workspace> ..." that acts on
// one workspace: args has words plain words (the first is the workspace) and
// at most the flags of toggle, and fill puts the rest in the request. It
// returns the process exit code.
func runWorkspaceTo(args []string, cmd string, toggle []string, words int, fill func(rq map[string]any, f flags)) int {
	usage := i18n.T("workspace." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, toggle)
	if !ok || len(f.rest) != words || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"workspace": f.rest[0]}
	fill(rq, f)
	return windowRun("workspace "+cmd, "workspace."+cmd, rq, nil)
}
