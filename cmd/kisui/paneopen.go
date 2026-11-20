package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runPaneOpen is "kisui pane open --workspace <name> [--new] --name <name>
// [--cwd <folder>] [--machine <machine>] [-- command ...]": the window adds a
// terminal tab at the end of its workspace of that name (a new workspace of that
// name with --new), and runs the command there (a shell when there is none), in
// the folder (the current one when there is no --cwd). The pane of the tab gets
// the name. The focus does not move. With --machine, the tab is a terminal of
// that machine: the folder and the command are the ones of that machine, so
// both are absolute paths there (no --cwd: the start folder of that machine).
// It returns the process exit code.
func runPaneOpen(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.open.usage"))
		return 0
	}
	op, ok := parseOpen(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("pane.open.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	rq := panecmd.Request{Cmd: "open-tab", Workspace: op.workspace, New: op.new, Name: op.name, Machine: op.machine}
	if op.machine != "" {
		// the folder and the command of that machine cannot be looked up here
		if op.cwd != "" && !filepath.IsAbs(op.cwd) {
			fmt.Fprintf(os.Stderr, i18n.T("pane.open.cwdAbs")+"\n", op.cwd)
			return 1
		}
		if len(op.argv) > 0 && !filepath.IsAbs(op.argv[0]) {
			fmt.Fprintf(os.Stderr, i18n.T("pane.open.cmdAbs")+"\n", op.argv[0])
			return 1
		}
		if op.cwd != "" {
			rq.Cwd = filepath.Clean(op.cwd)
		}
		rq.Argv = op.argv
	} else {
		wd, _ := os.Getwd()
		switch {
		case op.cwd == "":
			rq.Cwd = wd
		case filepath.IsAbs(op.cwd):
			rq.Cwd = filepath.Clean(op.cwd)
		default:
			rq.Cwd = filepath.Join(wd, op.cwd)
		}
		if len(op.argv) > 0 {
			argv, env, err := resolveCommand(op.argv)
			if err != nil {
				fmt.Fprintf(os.Stderr, i18n.T("pane.open.notfound")+"\n", op.argv[0])
				return 1
			}
			rq.Argv, rq.Env = argv, env
		}
	}
	if _, err := pane.Do(rq); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.open.failed"))
		return 1
	}
	return 0
}

// open is what parseOpen reads.
type open struct {
	workspace, name, cwd, machine string
	new                           bool
	argv                          []string
}

// parseOpen reads the arguments of "kisui pane open": --workspace <name> and
// --name <name> (both once, not empty), at most one --cwd <folder>, --machine
// <machine> and --new, then the command (everything from the first word that
// is not a flag, or after "--"). A flag with a value may also be written
// --flag=value. It reports false for anything else.
func parseOpen(args []string) (open, bool) {
	var op open
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		flag, value, inline := strings.Cut(a, "=")
		switch flag {
		case "--workspace", "--name", "--cwd", "--machine":
			if seen[flag] {
				return open{}, false
			}
			seen[flag] = true
			if !inline {
				if i+1 >= len(args) {
					return open{}, false
				}
				i++
				value = args[i]
			}
			if strings.TrimSpace(value) == "" {
				return open{}, false
			}
			switch flag {
			case "--workspace":
				op.workspace = value
			case "--name":
				op.name = value
			case "--machine":
				op.machine = value
			default:
				op.cwd = value
			}
			continue
		case "--new":
			if seen[flag] || inline {
				return open{}, false
			}
			seen[flag] = true
			op.new = true
			continue
		}
		switch {
		case a == "--":
			i++
		case len(a) > 0 && a[0] == '-':
			return open{}, false
		}
		if i < len(args) {
			op.argv = args[i:]
		}
		break
	}
	return op, op.workspace != "" && op.name != ""
}

// resolveCommand makes the first word of argv a full path, from the PATH of
// this pane, and gives that PATH as env: "kisui serve" starts the command from
// its own environment (kisui pane split and kisui pane open).
func resolveCommand(argv []string) (full, env []string, err error) {
	path, err := exec.LookPath(argv[0])
	if err == nil {
		path, err = filepath.Abs(path)
	}
	if err != nil {
		return nil, nil, err
	}
	if p, ok := os.LookupEnv("PATH"); ok {
		env = []string{"PATH=" + p}
	}
	return append([]string{path}, argv[1:]...), env, nil
}
