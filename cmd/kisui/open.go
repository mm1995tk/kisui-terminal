package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// runOpen is "kisui open [--pane] <file|url>". An image is shown in the pane it
// runs in, at the cursor, by the escape sequences of kitty's graphics protocol
// written to stdout (so it works in a remote pane too, and kisui serve takes no
// part in it). Everything else, and an image with --pane (or one that cannot be
// shown that way: see inlineImage), is for the "kisui serve" of the pane: it
// shows the file (a video, an image or a PDF, by its kind) or the http or https
// page in a pane of the workspace. It returns the process exit code.
func runOpen(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("open.usage"))
		return 0
	}
	inPane := false
	if i := slices.Index(args, "--pane"); i >= 0 {
		inPane = true
		args = slices.Delete(slices.Clone(args), i, i+1)
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprintln(os.Stderr, i18n.T("open.usage"))
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	target := args[0]
	if !panecmd.HasScheme(target) {
		if target, err = filepath.Abs(target); err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("open.failed")+"\n", err)
			return 1
		}
		if !inPane {
			if seq, ok := inlineImage(int(os.Stdout.Fd()), target); ok {
				if _, err := os.Stdout.Write(seq); err != nil {
					fmt.Fprintf(os.Stderr, i18n.T("open.failed")+"\n", err)
					return 1
				}
				return 0
			}
		}
	}
	if _, err := pane.Do(panecmd.Request{Cmd: "open", Target: target}); err != nil {
		fmt.Fprintln(os.Stderr, paneError(err, "open.failed"))
		return 1
	}
	return 0
}

// paneError is the message of err from panecmd: that the command does not run
// in a pane, that "kisui serve" is not running, or else the reason why it
// refused in the words of key.
func paneError(err error, key string) string {
	switch {
	case errors.Is(err, panecmd.ErrNotInPane):
		return i18n.T("pane.outside")
	case errors.Is(err, panecmd.ErrNoServer):
		return fmt.Sprintf(i18n.T("pane.noserve"), err)
	}
	return fmt.Sprintf(i18n.T(key), err)
}
