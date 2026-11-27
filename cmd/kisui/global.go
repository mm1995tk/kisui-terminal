package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// "kisui sidebar", "kisui scale", "kisui notice" and "kisui mascot": the
// Commands of the window that act on the whole window (#517), not on a tab.
// Each asks the window (window.go), which does what the key of the Command
// does. The window takes them only from a pane of the computer it runs on.

// runSidebarToggle is "kisui sidebar toggle": show or hide the sidebar.
func runSidebarToggle(args []string) int {
	return runWindowNoArgs(args, "sidebar.toggle.usage", "sidebar toggle", "sidebar.toggle")
}

// runScale is "kisui scale in|out|reset": make the display larger, smaller,
// or the original size (while a browser tab is shown, the size of its page,
// as the key does).
func runScale(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("scale.usage"))
		return 0
	}
	if len(args) != 1 || (args[0] != "in" && args[0] != "out" && args[0] != "reset") {
		fmt.Fprintln(os.Stderr, i18n.T("scale.usage"))
		return 2
	}
	return windowRun("scale", "scale", map[string]any{"action": args[0]}, nil)
}

// runNoticeUpdate is "kisui notice update": update to the new version that a
// notice offers, and restart.
func runNoticeUpdate(args []string) int {
	return runWindowNoArgs(args, "notice.update.usage", "notice update", "notice.update")
}

// runNoticeDismiss is "kisui notice dismiss": dismiss the newest notice.
func runNoticeDismiss(args []string) int {
	return runWindowNoArgs(args, "notice.dismiss.usage", "notice dismiss", "notice.dismiss")
}

// runNoticeFocusNotified is "kisui notice focus-notified": go to the pane that
// showed the last notification.
func runNoticeFocusNotified(args []string) int {
	return runWindowNoArgs(args, "notice.focusNotified.usage", "notice focus-notified", "notice.focusNotified")
}

// runNoticeOpenDownload is "kisui notice open-download": open the file the
// built-in browser downloaded last.
func runNoticeOpenDownload(args []string) int {
	return runWindowNoArgs(args, "notice.openDownload.usage", "notice open-download", "notice.openDownload")
}

// runNoticeRevealDownload is "kisui notice reveal-download": show the folder
// of the file the built-in browser downloaded last.
func runNoticeRevealDownload(args []string) int {
	return runWindowNoArgs(args, "notice.revealDownload.usage", "notice reveal-download", "notice.revealDownload")
}

// mascotList is the answer to "mascot.list". "kisui mascot list --json"
// prints it as it is.
type mascotList struct {
	// Current is the name of the character in use, null when none is chosen.
	Current *string       `json:"current"`
	Entries []mascotEntry `json:"entries"`
}

// mascotEntry is one character of mascotList.
type mascotEntry struct {
	Name string `json:"name"`
	// Error is why the character cannot be used, null when it can.
	Error *string `json:"error"`
}

// runMascotList is "kisui mascot list [--json]": the characters that can be
// chosen, with a "*" in front of the one in use.
func runMascotList(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("mascot.list.usage"))
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("mascot.list.usage"))
		return 2
	}
	var out mascotList
	if code := windowRun("mascot list", "mascot.list", nil, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		if out.Entries == nil {
			out.Entries = []mascotEntry{}
		}
		e := json.NewEncoder(os.Stdout)
		e.SetIndent("", "  ")
		err = e.Encode(out)
	} else {
		err = writeMascotList(os.Stdout, out)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("mascot list", err))
		return 1
	}
	return 0
}

// writeMascotList writes the characters for a person: one line each, "*" in
// front of the one in use, and why after one that cannot be used.
func writeMascotList(w io.Writer, l mascotList) error {
	var b strings.Builder
	for _, e := range l.Entries {
		mark := " "
		if l.Current != nil && *l.Current == e.Name {
			mark = "*"
		}
		line := mark + " " + tableCell(e.Name)
		if e.Error != nil {
			line += "  (" + tableCell(*e.Error) + ")"
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// runMascotSelect is "kisui mascot select <name>": use the character name
// (written to config.local.toml, as the key does; no dialog opens).
func runMascotSelect(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("mascot.select.usage"))
		return 0
	}
	f, ok := parseFlags(args, nil, nil)
	if !ok || len(f.rest) != 1 || strings.TrimSpace(f.rest[0]) == "" {
		fmt.Fprintln(os.Stderr, i18n.T("mascot.select.usage"))
		return 2
	}
	return windowRun("mascot select", "mascot.select", map[string]any{"name": f.rest[0]}, nil)
}

// runMascotReload is "kisui mascot reload": read the character in use again.
func runMascotReload(args []string) int {
	return runWindowNoArgs(args, "mascot.reload.usage", "mascot reload", "mascot.reload")
}

// runWindowNoArgs asks the window to do command, which takes no arguments.
// usage is the i18n key of its usage and name the words after "kisui".
func runWindowNoArgs(args []string, usage, name, command string) int {
	if code, done := noArgs(args, usage); done {
		return code
	}
	return windowRun(name, command, nil, nil)
}
