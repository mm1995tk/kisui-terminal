package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/kittyterm"
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
	t, err := kittyterm.OpenTTY()
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.none")+"\n", "kisui notify", err)
		return 1
	}
	defer t.Close()
	if err := t.Write(kittyterm.Notification(text)); err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.failed")+"\n", "kisui notify", err)
		return 1
	}
	return 0
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
	t, err := kittyterm.OpenTTY()
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.none")+"\n", name, err)
		return 1
	}
	defer t.Close()
	id := kittyterm.NewID()
	if err := t.Ask(kittyterm.ClipboardWrite(id, data), copyTimeout, kittyterm.WriteReply(id)); err != nil {
		return clipboardError(name, err)
	}
	return 0
}

// runClipboardPaste is "kisui clipboard paste": the text on the clipboard of
// the computer the GUI runs on, to stdout. The GUI asks the user every time
// whether to let it read the clipboard.
func runClipboardPaste(args []string) int {
	const name = "kisui clipboard paste"
	if code, done := noArgs(args, "clipboard.paste.usage"); done {
		return code
	}
	t, err := kittyterm.OpenTTY()
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.none")+"\n", name, err)
		return 1
	}
	defer t.Close()
	r := &kittyterm.TextReply{ID: kittyterm.NewID()}
	if err := t.Ask(kittyterm.ClipboardRead(r.ID), pasteTimeout, r.Handle); err != nil {
		return clipboardError(name, err)
	}
	if _, err := os.Stdout.Write(r.Text); err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("tty.failed")+"\n", name, err)
		return 1
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

// clipboardError writes why the clipboard command name failed and returns its
// exit code (130 when the user stopped it, as a shell does).
func clipboardError(name string, err error) int {
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
