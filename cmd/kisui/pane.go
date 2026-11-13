package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runPaneSplit is "kisui pane split --right|--down|--left|--up [command ...]": the "kisui
// serve" of the pane it runs in splits that pane to the right, down, left or up, and runs
// the command in the new pane (a shell when there is none). It returns the
// process exit code.
func runPaneSplit(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.split.usage"))
		return 0
	}
	dir, argv, ok := parseSplit(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("pane.split.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	rq := panecmd.Request{Cmd: "split", Dir: dir}
	if rq.Cwd, err = os.Getwd(); err != nil {
		rq.Cwd = ""
	}
	if len(argv) > 0 {
		// The server starts the command from its own environment, so it gets the full path and the PATH of this pane.
		path, err := exec.LookPath(argv[0])
		if err == nil {
			path, err = filepath.Abs(path)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("pane.split.notfound")+"\n", argv[0])
			return 1
		}
		rq.Argv = append([]string{path}, argv[1:]...)
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

// parseSplit reads the arguments of "kisui pane split": exactly one of --right,
// --down, --left and --up, then the command (everything from the first word that is not a
// flag, or after "--"). It reports false for anything else.
func parseSplit(args []string) (dir string, argv []string, ok bool) {
	for i, a := range args {
		switch a {
		case "--right", "--down", "--left", "--up":
			if dir != "" {
				return "", nil, false
			}
			dir = a[2:]
			continue
		case "--":
			i++
		}
		if len(a) > 0 && a[0] == '-' && a != "--" {
			return "", nil, false
		}
		return dir, args[i:], dir != ""
	}
	return dir, nil, dir != ""
}

// runPaneTitle is "kisui pane title <name>": the "kisui serve" of the pane it
// runs in shows the name on that pane. An empty name takes the name away.
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
