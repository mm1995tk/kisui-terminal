package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"unicode"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runPaneSplit is "kisui pane split --right|--down|--left|--up [--name <name>] [command ...]":
// the "kisui serve" of the pane it runs in splits that pane to the right, down, left or up, and
// runs the command in the new pane (a shell when there is none). With --name, the
// new pane gets that name (refused, with no new pane, when another pane of the
// machine has it). It returns the process exit code.
func runPaneSplit(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.split.usage"))
		return 0
	}
	sp, ok := parseSplit(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("pane.split.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	rq := panecmd.Request{Cmd: "split", Dir: sp.dir, Name: sp.name}
	if rq.Cwd, err = os.Getwd(); err != nil {
		rq.Cwd = ""
	}
	if len(sp.argv) > 0 {
		// The server starts the command from its own environment, so it gets the full path and the PATH of this pane.
		path, err := exec.LookPath(sp.argv[0])
		if err == nil {
			path, err = filepath.Abs(path)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("pane.split.notfound")+"\n", sp.argv[0])
			return 1
		}
		rq.Argv = append([]string{path}, sp.argv[1:]...)
		if p, ok := os.LookupEnv("PATH"); ok {
			rq.Env = []string{"PATH=" + p}
		}
	}
	if _, err := pane.Do(rq); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.split.failed"))
		return 1
	}
	return 0
}

// split is what parseSplit reads: the direction, the name of the new pane ("" for
// none) and the command.
type split struct {
	dir, name string
	argv      []string
}

// parseSplit reads the arguments of "kisui pane split": exactly one of --right,
// --down, --left and --up, at most one --name <name> (or --name=<name>; not
// empty), then the command (everything from the first word that is not a flag,
// or after "--"). It reports false for anything else.
func parseSplit(args []string) (split, bool) {
	var sp split
	named := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--right" || a == "--down" || a == "--left" || a == "--up":
			if sp.dir != "" {
				return split{}, false
			}
			sp.dir = a[2:]
			continue
		case a == "--name" || strings.HasPrefix(a, "--name="):
			if named {
				return split{}, false
			}
			named = true
			if v, ok := strings.CutPrefix(a, "--name="); ok {
				sp.name = v
			} else if i+1 < len(args) {
				i++
				sp.name = args[i]
			}
			if strings.TrimSpace(sp.name) == "" {
				return split{}, false
			}
			continue
		case a == "--":
			i++
		case len(a) > 0 && a[0] == '-':
			return split{}, false
		}
		sp.argv = args[i:]
		if len(sp.argv) == 0 {
			sp.argv = nil
		}
		return sp, sp.dir != ""
	}
	return sp, sp.dir != ""
}

// runPaneTitle is "kisui pane title <name>": the "kisui serve" of the pane it
// runs in shows the name on that pane. An empty name takes the name away. A
// name that another pane of the machine has is refused.
func runPaneTitle(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.title.usage"))
		return 0
	}
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, i18n.T("pane.title.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	if _, err := pane.Do(panecmd.Request{Cmd: "title", Title: args[0]}); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.title.failed"))
		return 1
	}
	return 0
}

// runPaneList is "kisui pane list [--json]": the panes (terminals) of the
// machine of the pane it runs in, of every workspace and tab. --json prints
// them as JSON ({"panes": [panecmd.PaneInfo...]}) for a program to read.
func runPaneList(args []string) int {
	asJSON := false
	switch {
	case len(args) == 1 && (args[0] == "-h" || args[0] == "--help"):
		fmt.Println(i18n.T("pane.list.usage"))
		return 0
	case len(args) == 1 && args[0] == "--json":
		asJSON = true
	case len(args) != 0:
		fmt.Fprintln(os.Stderr, i18n.T("pane.list.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	r, err := pane.Do(panecmd.Request{Cmd: "list"})
	if err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.list.failed"))
		return 1
	}
	if asJSON {
		err = writePaneListJSON(os.Stdout, r.Panes)
	} else {
		err = writePaneList(os.Stdout, r.Panes)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.list.failed"))
		return 1
	}
	return 0
}

// writePaneListJSON writes the panes as {"panes": [...]}, an empty list as [].
func writePaneListJSON(w io.Writer, panes []panecmd.PaneInfo) error {
	if panes == nil {
		panes = []panecmd.PaneInfo{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Panes []panecmd.PaneInfo `json:"panes"`
	}{panes})
}

// writePaneList writes the panes as a table for a person: one line each, with
// a "*" in front of the pane it runs in. Empty columns are "-".
func writePaneList(w io.Writer, panes []panecmd.PaneInfo) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "  "+i18n.T("pane.list.header"))
	// cell is the text of one column: control characters (a tab would break the table) become spaces, and empty is "-".
	cell := func(s string) string {
		s = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, s))
		if s == "" {
			return "-"
		}
		return s
	}
	for _, p := range panes {
		mark := " "
		if p.Self {
			mark = "*"
		}
		var notes []string
		if p.Primary {
			notes = append(notes, i18n.T("pane.list.primary"))
		}
		if !p.Alive {
			notes = append(notes, i18n.T("pane.list.ended"))
		}
		fmt.Fprintf(tw, "%s %s\t%s\t%s\t%s\t%s\t%s\n", mark, p.ID, cell(p.Name), cell(p.Tab+" "+p.TabName), cell(p.Cwd), cell(p.Title), cell(strings.Join(notes, ",")))
	}
	return tw.Flush()
}
