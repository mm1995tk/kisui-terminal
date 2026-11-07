// Command kisui is the server of kisui-terminal: "kisui serve" is the headless
// server the GUI talks to and "kisui attach" the bridge to it. The other
// commands run in a pane: "kisui open" asks the "kisui serve" of the pane for
// something (internal/panecmd), and "kisui notify" and "kisui clipboard" talk
// to the terminal of the pane (internal/kittyterm).
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// command is a subcommand of kisui. A command has run, or sub: the commands
// under it ("kisui <group> <command>", such as "kisui pane split"). To add one,
// add it to commands (or to the sub of its group) and its line of the help to
// internal/i18n.
type command struct {
	name string
	args string // the arguments in the help, such as "<file|url>"
	help string // the i18n key of its line in the help
	run  func(args []string) int
	sub  []command
}

var commands = []command{
	{name: "serve", help: "help.serve", run: runServe},
	{name: "attach", help: "help.attach", run: runAttach},
	{name: "open", args: "<file|url>", help: "help.open", run: runOpen},
	{name: "notify", args: "<text>", help: "help.notify", run: runNotify},
	{name: "clipboard", sub: []command{
		{name: "copy", help: "help.clipboard.copy", run: runClipboardCopy},
		{name: "paste", help: "help.clipboard.paste", run: runClipboardPaste},
	}},
}

func main() {
	if len(os.Args) >= 2 && (os.Args[1] == "-v" || os.Args[1] == "--version") {
		fmt.Println("kisui " + buildinfo.Label())
		return
	}
	setLang()
	os.Exit(dispatch(commands, "kisui", os.Args[1:], os.Stdout, os.Stderr))
}

// dispatch runs the command that args name among cmds (prefix is the words
// before them, "kisui" at the top). "-h" or "--help" writes the list of the
// commands to stdout; anything else that is not a command writes it to stderr.
// It returns the exit code.
func dispatch(cmds []command, prefix string, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		for _, c := range cmds {
			if c.name != args[0] {
				continue
			}
			if c.run != nil {
				return c.run(args[1:])
			}
			return dispatch(c.sub, prefix+" "+c.name, args[1:], stdout, stderr)
		}
		if args[0] == "-h" || args[0] == "--help" {
			usage(stdout, cmds, prefix)
			return 0
		}
	}
	usage(stderr, cmds, prefix)
	return 2
}

// usage writes the list of the commands under prefix, one line each.
func usage(w io.Writer, cmds []command, prefix string) {
	type line struct{ synopsis, help string }
	var lines []line
	var walk func(cmds []command, prefix string)
	walk = func(cmds []command, prefix string) {
		for _, c := range cmds {
			if c.run == nil {
				walk(c.sub, prefix+" "+c.name)
				continue
			}
			s := prefix + " " + c.name
			if c.args != "" {
				s += " " + c.args
			}
			lines = append(lines, line{s, i18n.T(c.help)})
		}
	}
	walk(cmds, prefix)
	if prefix == "kisui" {
		lines = append(lines, line{"kisui --version", i18n.T("help.version")}, line{"kisui --help", i18n.T("help.help")})
	}
	width := 0
	for _, l := range lines {
		width = max(width, len(l.synopsis))
	}
	var b strings.Builder
	fmt.Fprintf(&b, i18n.T("kisui.usage")+"\n\n", prefix)
	for _, l := range lines {
		fmt.Fprintf(&b, "  %-*s  %s\n", width, l.synopsis, l.help)
	}
	_, _ = io.WriteString(w, b.String())
}

// setLang sets the language of the messages from the settings, for the
// commands that need nothing else from them. A mistake in the files is not
// reported here: serve reports it, and the others work without settings.
func setLang() {
	cfg, _ := config.Load(buildinfo.Suffix())
	i18n.SetLang(cfg.UILanguage)
}

// configErrorText is err for a terminal: a *config.Error gets a heading with
// its count.
func configErrorText(err error) string {
	if ce, ok := errors.AsType[*config.Error](err); ok {
		return fmt.Sprintf(i18n.T("config.err.head"), len(ce.Problems)) + "\n" + ce.Error()
	}
	return err.Error()
}
