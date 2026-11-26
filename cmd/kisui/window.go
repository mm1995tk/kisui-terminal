package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// The commands that ask the window ("kisui tab" and the ones to come). The
// window owns its workspaces, tabs, focus and what is shown, so "kisui serve"
// passes the request on without looking at it (the request "window" of
// internal/panecmd): a name written like the id of a Command of the window
// ("tab.rename") and its arguments as a JSON object. The window does it and
// answers with JSON. To add such a command, add it to commands (main.go) and
// call windowRun; "kisui serve" stays as it is, and the window gets a handler
// of that name (app/src/features/commands/windowRun.ts).

// windowRun asks the window to do command with args (marshalled to a JSON
// object; nil for none) and reads its answer into out (nil to drop it). name
// is the words after "kisui" ("tab rename"), for the message of a failure,
// which it writes to stderr. It returns the process exit code.
func windowRun(name, command string, args, out any) int {
	return windowRunWith(name, panecmd.Request{Command: command}, args, out)
}

// windowRunWith is windowRun with the request to fill (for Long: a request
// the window asks a person about, which waits longer).
func windowRunWith(name string, rq panecmd.Request, args, out any) int {
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	rq.Cmd = "window"
	if args != nil {
		if rq.Args, err = json.Marshal(args); err != nil {
			fmt.Fprintln(os.Stderr, windowError(name, err))
			return 1
		}
	}
	r, err := pane.Do(rq)
	if err == nil && out != nil {
		if len(r.Result) == 0 {
			err = errors.New("the window answered nothing")
		} else {
			err = json.Unmarshal(r.Result, out)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError(name, err))
		return 1
	}
	return 0
}

// windowError is the message for a failure of "kisui <name>".
func windowError(name string, err error) string {
	switch {
	case errors.Is(err, panecmd.ErrNotInPane):
		return i18n.T("pane.outside")
	case errors.Is(err, panecmd.ErrNoServer):
		return fmt.Sprintf(i18n.T("pane.noserve"), err)
	}
	return fmt.Sprintf("kisui %s: %s", name, err)
}

// flags is what parseFlags read: the values of the flags that take one, the
// flags without a value that were given, and the other words in order.
type flags struct {
	value map[string]string
	on    map[string]bool
	rest  []string
}

// parseFlags reads args: the flags of value take a value ("--flag v" or
// "--flag=v"; not blank), the ones of toggle take none. Each may come once,
// anywhere among the other words; after "--" every word is a plain word (for
// one that starts with "-"). It reports false for an unknown flag, a flag
// given twice, or a missing value.
func parseFlags(args []string, value, toggle []string) (flags, bool) {
	f := flags{value: map[string]string{}, on: map[string]bool{}}
	has := func(list []string, s string) bool {
		for _, x := range list {
			if x == s {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			f.rest = append(f.rest, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			if len(a) > 1 && a[0] == '-' {
				return flags{}, false
			}
			f.rest = append(f.rest, a)
			continue
		}
		name, v, inline := strings.Cut(a, "=")
		switch {
		case has(value, name):
			if _, dup := f.value[name]; dup {
				return flags{}, false
			}
			if !inline {
				if i+1 >= len(args) {
					return flags{}, false
				}
				i++
				v = args[i]
			}
			if strings.TrimSpace(v) == "" {
				return flags{}, false
			}
			f.value[name] = v
		case has(toggle, name) && !inline && !f.on[name]:
			f.on[name] = true
		default:
			return flags{}, false
		}
	}
	return f, true
}

// isHelp reports whether args ask for the usage ("-h" or "--help" alone).
func isHelp(args []string) bool {
	return len(args) == 1 && (args[0] == "-h" || args[0] == "--help")
}
