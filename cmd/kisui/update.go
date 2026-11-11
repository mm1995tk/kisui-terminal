package main

import (
	"fmt"
	"io"
	"os"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runUpdate is "kisui update": the window of the pane it runs in looks for a
// newer version of kisui-terminal now. When there is one, the window shows its
// "a new version is available" notice (the same one as at start-up). It prints
// what the window found and returns the process exit code.
func runUpdate(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("update.usage"))
		return 0
	}
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("update.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	r, err := pane.Do(panecmd.Request{Cmd: "update"})
	if err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "update.failed"))
		return 1
	}
	return printUpdate(os.Stdout, os.Stderr, r.Update)
}

// printUpdate writes what the window found (u) and returns the exit code: 0
// unless the check failed.
func printUpdate(stdout, stderr io.Writer, u *panecmd.UpdateResult) int {
	switch {
	case u == nil:
		fmt.Fprintf(stderr, i18n.T("update.failed")+"\n", "no answer")
		return 1
	case u.Status == panecmd.UpdateAvailable:
		fmt.Fprintf(stdout, i18n.T("update.available")+"\n", u.Version, u.Current)
	case u.Status == panecmd.UpdateLatest:
		fmt.Fprintf(stdout, i18n.T("update.latest")+"\n", u.Current)
	case u.Status == panecmd.UpdateManual:
		fmt.Fprintln(stdout, i18n.T("update.manual"))
	default:
		fmt.Fprintf(stderr, i18n.T("update.checkfailed")+"\n", u.Error)
		return 1
	}
	return 0
}
