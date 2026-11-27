// Command kisui is the server of kisui-terminal: "kisui serve" is the headless
// server the GUI talks to, "kisui attach" the bridge to it, and "kisui relay"
// relays the GUI's connections to the localhost ports of a remote machine.
// "kisui proxy" runs the recording proxy by itself. The
// other commands run in a pane: "kisui open" asks the "kisui serve" of the pane for
// something (internal/panecmd), "kisui tab" and "kisui workspace" ask the window through it
// (window.go), and "kisui notify" and "kisui clipboard" talk to the terminal
// of the pane (internal/kittyterm).
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
	{name: "relay", help: "help.relay", run: runRelay},
	{name: "proxy", args: "[--listen <addr>] [-v]", help: "help.proxy", run: runProxy},
	{name: "open", args: "<file|url>", help: "help.open", run: runOpen},
	{name: "update", help: "help.update", run: runUpdate},
	{name: "notify", args: "<text>", help: "help.notify", run: runNotify},
	{name: "clipboard", sub: []command{
		{name: "copy", help: "help.clipboard.copy", run: runClipboardCopy},
		{name: "paste", help: "help.clipboard.paste", run: runClipboardPaste},
	}},
	{name: "pane", sub: []command{
		{name: "split", args: "--right|--down|--left|--up [--name <name>] [command ...]", help: "help.pane.split", run: runPaneSplit},
		{name: "title", args: "<name>", help: "help.pane.title", run: runPaneTitle},
		{name: "read", args: "[--machine <machine>] <name|id> [--lines <n>]", help: "help.pane.read", run: runPaneRead},
		{name: "list", args: "[--json] [--machine <machine>]", help: "help.pane.list", run: runPaneList},
		{name: "open", args: "--workspace <name> [--new] --name <name> [--cwd <folder>] [--machine <machine>] [-- command ...]", help: "help.pane.open", run: runPaneOpen},
		{name: "send", args: "[--machine <machine>] <name|id> <text>", help: "help.pane.send", run: runPaneSend},
		{name: "keys", args: "[--machine <machine>] <name|id> <key>...", help: "help.pane.keys", run: runPaneKeys},
		{name: "close", args: "[--machine <machine>] <name|id>", help: "help.pane.close", run: runPaneClose},
	}},
	{name: "tab", sub: []command{
		{name: "list", args: "[--json] [--workspace <name|id>]", help: "help.tab.list", run: runTabList},
		{name: "rename", args: "<tab> <name>", help: "help.tab.rename", run: runTabRename},
		{name: "close", args: "[--force] <tab>", help: "help.tab.close", run: runTabClose},
		{name: "move", args: "<tab> --up|--down|--workspace <name|id>", help: "help.tab.move", run: runTabMove},
		{name: "show", args: "<tab>", help: "help.tab.show", run: runTabShow},
	}},
	{name: "workspace", sub: []command{
		{name: "list", args: "[--json]", help: "help.workspace.list", run: runWorkspaceList},
		{name: "new", args: "<name>", help: "help.workspace.new", run: runWorkspaceNew},
		{name: "rename", args: "<workspace> <name>", help: "help.workspace.rename", run: runWorkspaceRename},
		{name: "close", args: "[--force] <workspace>", help: "help.workspace.close", run: runWorkspaceClose},
		{name: "move", args: "<workspace> --up|--down", help: "help.workspace.move", run: runWorkspaceMove},
		{name: "show", args: "<workspace>", help: "help.workspace.show", run: runWorkspaceShow},
	}},
	{name: "db", sub: []command{
		{name: "connections", args: "[--json]", help: "help.db.connections", run: runDBConnections},
		{name: "schema", args: "[--variant <variant>] [--json] <connection> [<table>]", help: "help.db.schema", run: runDBSchema},
		{name: "query", args: "[--variant <variant>] [--max-rows <n>] [--json] <connection> <sql|->", help: "help.db.query", run: runDBQuery},
		{name: "propose", args: "[--variant <variant>] <connection> <sql|->", help: "help.db.propose", run: runDBPropose},
	}},
	{name: "skill", sub: []command{
		{name: "install", args: "[dir]", help: "help.skill.install", run: runSkillInstall},
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
