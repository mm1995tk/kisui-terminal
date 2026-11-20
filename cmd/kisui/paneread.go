package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runPaneRead is "kisui pane read <name|id> [--lines <n>] [--machine <machine>]":
// print the text on the screen of the pane of the machine (with --machine, of
// that machine) that has the name or id (of any workspace or tab), with no
// colors. --lines also prints n lines of the scrollback above the screen. It
// returns the process exit code.
func runPaneRead(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("pane.read.usage"))
		return 0
	}
	rd, ok := parseRead(args)
	if !ok {
		fmt.Fprintln(os.Stderr, i18n.T("pane.read.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	r, err := pane.Do(panecmd.Request{Cmd: "read", To: rd.target, Lines: rd.lines, Machine: rd.machine})
	if err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.read.failed"))
		return 1
	}
	if _, err := os.Stdout.WriteString(r.Text); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "pane.read.failed"))
		return 1
	}
	return 0
}

// read is what parseRead reads: the pane, the lines of the scrollback and the
// machine ("" for this one).
type read struct {
	target, machine string
	lines           int
}

// parseRead reads the arguments of "kisui pane read": one name or id (not empty),
// and at most one --lines <n> (or --lines=<n>; n is 0 or more) and one
// --machine <machine> (or --machine=<machine>) before or after it. A name that
// starts with "-" comes after "--". It reports false for anything else.
func parseRead(args []string) (read, bool) {
	var rd read
	hasTarget, hasLines := false, false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case !hasTarget && a == "--":
			if i+2 != len(args) {
				return read{}, false
			}
			rd.target, hasTarget = args[i+1], true
			i++
		case a == "--lines" || strings.HasPrefix(a, "--lines="):
			if hasLines {
				return read{}, false
			}
			hasLines = true
			v, eq := strings.CutPrefix(a, "--lines=")
			if !eq {
				if i+1 >= len(args) {
					return read{}, false
				}
				i++
				v = args[i]
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				return read{}, false
			}
			rd.lines = n
		case isMachineFlag(a):
			if rd.machine != "" {
				return read{}, false
			}
			m, n := machineFlag(args[i:])
			if n == 0 {
				return read{}, false
			}
			rd.machine = m
			i += n - 1
		case len(a) > 0 && a[0] == '-', hasTarget:
			return read{}, false
		default:
			rd.target, hasTarget = a, true
		}
	}
	return rd, hasTarget && rd.target != ""
}
