package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
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
		if rq.Argv, rq.Env, err = resolveCommand(sp.argv); err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("pane.split.notfound")+"\n", sp.argv[0])
			return 1
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

// runPaneList is "kisui pane list [--json] [--machine <machine>]": the panes
// (terminals) of the machine of the pane it runs in (with --machine, of that
// machine), of every workspace and tab, each with the workspace of the window
// (its id and name) and the tab it is in. --json prints them as JSON ({"panes":
// [panecmd.PaneInfo...]}) for a program to read.
func runPaneList(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.list.usage"))
		return 0
	}
	asJSON, machine, ok := parseList(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("pane.list.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	r, err := pane.Do(panecmd.Request{Cmd: "list", Machine: machine})
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

// parseList reads the arguments of "kisui pane list": at most one --json and
// one --machine <machine>, in any order. It reports false for anything else.
func parseList(args []string) (asJSON bool, machine string, ok bool) {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--json" && !asJSON:
			asJSON = true
		case isMachineFlag(args[i]) && machine == "":
			var n int
			if machine, n = machineFlag(args[i:]); n == 0 {
				return false, "", false
			}
			i += n - 1
		default:
			return false, "", false
		}
	}
	return asJSON, machine, true
}

// isMachineFlag reports whether a is "--machine" or "--machine=...".
func isMachineFlag(a string) bool {
	return a == "--machine" || strings.HasPrefix(a, "--machine=")
}

// machineFlag reads "--machine <machine>" or "--machine=<machine>" at the start
// of args: the machine and the number of words it took (0 when the machine is
// missing or empty).
func machineFlag(args []string) (string, int) {
	v, n := "", 1
	if after, eq := strings.CutPrefix(args[0], "--machine="); eq {
		v = after
	} else if len(args) > 1 {
		v, n = args[1], 2
	}
	if strings.TrimSpace(v) == "" {
		return "", 0
	}
	return v, n
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
	cell := tableCell
	rows := [][]string{append([]string{" "}, strings.Split(i18n.T("pane.list.header"), "\t")...)}
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
		rows = append(rows, []string{mark, cell(p.ID), cell(p.Name), cell(p.Workspace + " " + p.WorkspaceName), cell(p.Tab + " " + p.TabName), cell(p.Cwd), cell(p.Title), cell(strings.Join(notes, ","))})
	}
	// the mark and the id are one space apart, the other columns two
	_, err := io.WriteString(w, alignColumns(rows, 1))
	return err
}

// tableCell is the text of one column of a table: control characters become
// spaces, and empty is "-".
func tableCell(s string) string {
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

// alignColumns writes rows as lines whose columns line up by the width on the
// screen (a CJK character takes two columns; text/tabwriter counts one per
// character). gaps[i] is the number of spaces after column i at its widest; a
// column without one gets two. Spaces at the end of a line are dropped.
func alignColumns(rows [][]string, gaps ...int) string {
	var widths []int
	for _, r := range rows {
		for i, c := range r {
			if i >= len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], ansi.StringWidth(c))
		}
	}
	var b strings.Builder
	for _, r := range rows {
		var line strings.Builder
		for i, c := range r {
			line.WriteString(c)
			if i < len(r)-1 {
				gap := 2
				if i < len(gaps) {
					gap = gaps[i]
				}
				line.WriteString(strings.Repeat(" ", widths[i]-ansi.StringWidth(c)+gap))
			}
		}
		b.WriteString(strings.TrimRight(line.String(), " "))
		b.WriteString("\n")
	}
	return b.String()
}

// runPaneSend is "kisui pane send <name|id> <text>": type the text in the pane
// of the machine that has the name or id, and press Enter. The focus does not
// move.
func runPaneSend(args []string) int {
	return runPaneTo(args, "send", 2, 2, func(rq *panecmd.Request, rest []string) { rq.Text = rest[0] })
}

// runPaneKeys is "kisui pane keys <name|id> <key>...": press the keys (such as
// esc or ctrl+c) in the pane of the machine that has the name or id. The server
// knows the keys: an unknown one is refused before any key is sent.
func runPaneKeys(args []string) int {
	return runPaneTo(args, "keys", 2, -1, func(rq *panecmd.Request, rest []string) { rq.Keys = rest })
}

// runPaneClose is "kisui pane close <name|id>": close the pane of the machine
// that has the name or id. The primary pane of a tab is refused (it closes with
// its tab).
func runPaneClose(args []string) int {
	return runPaneTo(args, "close", 1, 1, func(*panecmd.Request, []string) {})
}

// runPaneTo runs a "kisui pane <cmd> [--machine <machine>] <name|id> ..." that
// acts on another pane: after the --machine (the pane is on that machine), args
// has least to most words (most < 0: no limit), the first is the pane, and fill
// puts the rest in the request. It returns the process exit code.
func runPaneTo(args []string, cmd string, least, most int, fill func(rq *panecmd.Request, rest []string)) int {
	usage := i18n.T("pane." + cmd + ".usage")
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(usage)
		return 0
	}
	machine := ""
	if len(args) > 0 && isMachineFlag(args[0]) {
		var n int
		if machine, n = machineFlag(args); n == 0 {
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		args = args[n:]
	}
	if len(args) < least || (most >= 0 && len(args) > most) || args[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	rq := panecmd.Request{Cmd: cmd, To: args[0], Machine: machine}
	fill(&rq, args[1:])
	if _, err := pane.Do(rq); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane."+cmd+".failed"))
		return 1
	}
	return 0
}
