package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/kittyterm"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// How long the clipboard commands wait for the terminal. A write is answered
// as soon as the GUI has put it on the clipboard. A read waits for the user to
// answer the GUI's question, so it waits longer (Ctrl+C stops it).
const (
	copyTimeout  = 10 * time.Second
	pasteTimeout = 5 * time.Minute
)

// runNotify is "kisui notify <text>": a desktop notification on the computer
// the GUI runs on, through the terminal (kitty's OSC 99).
func runNotify(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("notify.usage"))
		return 0
	}
	text := strings.Join(args, " ")
	if strings.TrimSpace(text) == "" {
		fmt.Fprintln(os.Stderr, i18n.T("notify.usage"))
		return 2
	}
	return withTTY("kisui notify", func(t *kittyterm.TTY) error {
		return t.Write(kittyterm.Notification(text))
	})
}

// runClipboardCopy is "kisui clipboard copy": the text of stdin on the
// clipboard of the computer the GUI runs on (kitty's OSC 5522).
func runClipboardCopy(args []string) int {
	const name = "kisui clipboard copy"
	if code, done := noArgs(args, "clipboard.copy.usage"); done {
		return code
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.failed")+"\n", name, err)
		return 1
	}
	return withTTY(name, func(t *kittyterm.TTY) error {
		id := kittyterm.NewID()
		// shj calls pbcopy when it copies, while it reads the terminal itself
		return t.AskUnlessKeys(kittyterm.ClipboardWrite(id, data), copyTimeout, kittyterm.WriteReply(id))
	})
}

// runClipboardPaste is "kisui clipboard paste": the text on the clipboard of
// the computer the GUI runs on, to stdout. The GUI asks the user every time
// whether to let it read the clipboard.
func runClipboardPaste(args []string) int {
	if code, done := noArgs(args, "clipboard.paste.usage"); done {
		return code
	}
	return withTTY("kisui clipboard paste", func(t *kittyterm.TTY) error {
		r := &kittyterm.TextReply{ID: kittyterm.NewID()}
		if err := t.Ask(kittyterm.ClipboardRead(r.ID), pasteTimeout, r.Handle); err != nil {
			return err
		}
		_, err := os.Stdout.Write(r.Text)
		return err
	})
}

// withTTY runs f on the terminal of the command name and returns the exit
// code: 1 when there is no terminal or f fails (with why on stderr), 130 when
// the user stopped it, as a shell does.
func withTTY(name string, f func(*kittyterm.TTY) error) int {
	t, err := kittyterm.OpenTTY()
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.none")+"\n", name, err)
		return 1
	}
	defer t.Close()
	if err := f(t); err != nil {
		return ttyError(name, err)
	}
	return 0
}

// noArgs handles the arguments of a command that takes none: "-h" prints the
// usage of key, anything else is a mistake. done is false when there are none.
func noArgs(args []string, key string) (code int, done bool) {
	switch {
	case len(args) == 0:
		return 0, false
	case len(args) == 1 && (args[0] == "-h" || args[0] == "--help"):
		fmt.Println(i18n.T(key))
		return 0, true
	}
	fmt.Fprintln(os.Stderr, i18n.T(key))
	return 2, true
}

// ttyError writes why the command name failed on the terminal and returns its
// exit code (130 when the user stopped it, as a shell does).
func ttyError(name string, err error) int {
	var se *kittyterm.StatusError
	switch {
	case errors.Is(err, kittyterm.ErrInterrupted):
		return 130
	case errors.Is(err, kittyterm.ErrTimeout):
		fmt.Fprintf(os.Stderr, i18n.T("tty.timeout")+"\n", name)
	case errors.As(err, &se) && se.Status == "EPERM":
		fmt.Fprintf(os.Stderr, i18n.T("clipboard.denied")+"\n", name)
	default:
		fmt.Fprintf(os.Stderr, i18n.T("tty.failed")+"\n", name, err)
	}
	return 1
}

// historyEntry is one entry of the clipboard history in the answer to
// "clipboard.history". "kisui clipboard history --json" prints these as they
// are.
type historyEntry struct {
	Text string `json:"text"`
	// CopiedAt is when it was copied, in milliseconds since the Unix epoch.
	CopiedAt int64 `json:"copiedAt"`
}

// historyPreview is the most characters of an entry that "kisui clipboard
// history" prints on its line (--json prints all of it).
const historyPreview = 100

// runClipboardHistory is "kisui clipboard history [--json]": the clipboard
// history of the window (the text copied before), newest first. It asks the
// window, which asks the user every time whether to let it read the history,
// and takes it only from a pane of the computer it runs on.
func runClipboardHistory(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("clipboard.history.usage"))
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("clipboard.history.usage"))
		return 2
	}
	var out struct {
		Entries []historyEntry `json:"entries"`
	}
	// the window asks a person, so "kisui serve" waits longer
	if code := windowRunWith("clipboard history", panecmd.Request{Command: "clipboard.history", Long: true}, nil, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		if out.Entries == nil {
			out.Entries = []historyEntry{}
		}
		e := json.NewEncoder(os.Stdout)
		e.SetIndent("", "  ")
		err = e.Encode(out)
	} else {
		err = writeHistory(os.Stdout, out.Entries)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("clipboard history", err))
		return 1
	}
	return 0
}

// writeHistory writes the entries for a person: one line each, its number
// (1 is the newest), when it was copied, and the text on one line, cut after
// historyPreview characters.
func writeHistory(w io.Writer, entries []historyEntry) error {
	rows := [][]string{}
	for i, e := range entries {
		text := []rune(strings.Join(strings.Fields(e.Text), " "))
		line := string(text)
		if len(text) > historyPreview {
			line = string(text[:historyPreview]) + "…"
		}
		at := time.UnixMilli(e.CopiedAt).Local().Format("2006-01-02 15:04")
		rows = append(rows, []string{fmt.Sprint(i + 1), at, tableCell(line)})
	}
	if len(rows) == 0 {
		return nil
	}
	_, err := io.WriteString(w, alignColumns(rows))
	return err
}
