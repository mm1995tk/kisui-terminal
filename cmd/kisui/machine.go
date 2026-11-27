package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// "kisui machine": the machines of the window, what the machine dialog of the
// window (leader m) lists and does. Each command asks the window (window.go),
// which writes config.local.toml as the dialog does. The window takes these
// only from a pane of the computer it runs on: they change where the window
// connects and its settings, so a pane of a remote machine is refused, whatever
// it is allowed. <machine> is the name of a machine (the one "--machine"
// takes; "local" is the computer of the window) or its ssh destination.

// machineInfo is one machine in the answer to "machine.list". "kisui machine
// list --json" prints these as they are, so the names of the fields are what
// an agent reads.
type machineInfo struct {
	Name string `json:"name"`
	// SSH is the ssh destination; empty for the computer of the window.
	SSH       string `json:"ssh,omitempty"`
	Connected bool   `json:"connected"`
	// Status is the line of the machine dialog about the connection.
	Status       string `json:"status"`
	TerminalTabs int    `json:"terminalTabs"`
	// Fixed is a machine only in config.toml, which the window does not change.
	Fixed bool `json:"fixed,omitempty"`
}

// terminalInfo is the answer to "machine.terminal": the folder a new terminal
// of the machine starts in and its shell, empty when not set.
type terminalInfo struct {
	StartDir string `json:"startDir,omitempty"`
	Shell    string `json:"shell,omitempty"`
}

// runMachineList is "kisui machine list [--json]": the machines in the order
// of the machine dialog.
func runMachineList(args []string) int {
	if isHelp(args) {
		fmt.Println(i18n.T("machine.list.usage"))
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("machine.list.usage"))
		return 2
	}
	var out struct {
		Machines []machineInfo `json:"machines"`
	}
	if code := windowRun("machine list", "machine.list", map[string]any{}, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		err = writeMachineListJSON(os.Stdout, out.Machines)
	} else {
		err = writeMachineList(os.Stdout, out.Machines)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("machine list", err))
		return 1
	}
	return 0
}

// writeMachineListJSON writes the machines as {"machines": [...]}, an empty
// list as [].
func writeMachineListJSON(w io.Writer, list []machineInfo) error {
	if list == nil {
		list = []machineInfo{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Machines []machineInfo `json:"machines"`
	}{list})
}

// writeMachineList writes the machines as a table for a person, one line each.
func writeMachineList(w io.Writer, list []machineInfo) error {
	rows := [][]string{strings.Split(i18n.T("machine.list.header"), "\t")}
	for _, m := range list {
		state := i18n.T("machine.list.down")
		if m.Connected {
			state = i18n.T("machine.list.up")
		}
		note := ""
		if m.Fixed {
			note = "config.toml"
		}
		rows = append(rows, []string{tableCell(m.Name), tableCell(m.SSH), state, fmt.Sprint(m.TerminalTabs), tableCell(note), tableCell(m.Status)})
	}
	_, err := io.WriteString(w, alignColumns(rows))
	return err
}

// runMachineAdd is "kisui machine add [--name <name>] <ssh>": connect to the
// ssh destination and, once connected, add it to config.local.toml, as the
// add dialog does. The window may ask the person (to install kisui there, or
// a password of ssh), so it waits longer. It prints the name of the machine.
func runMachineAdd(args []string) int {
	usage := i18n.T("machine.add.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--name"}, nil)
	if !ok || len(f.rest) != 1 || strings.TrimSpace(f.rest[0]) == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"ssh": f.rest[0]}
	if n, ok := f.value["--name"]; ok {
		rq["name"] = n
	}
	var out struct {
		Name string `json:"name"`
	}
	if code := windowRunWith("machine add", panecmd.Request{Command: "machine.add", Long: true}, rq, &out); code != 0 {
		return code
	}
	fmt.Println(out.Name)
	return 0
}

// runMachineRename is "kisui machine rename <machine> <name>". An empty name
// gives back the ssh destination as the name.
func runMachineRename(args []string) int {
	return runMachineTo(args, "rename", 2, func(rq map[string]any, rest []string) {
		rq["name"] = rest[1]
	})
}

// runMachineRemove is "kisui machine remove <machine>": take it out of
// config.local.toml and disconnect it ("kisui serve" there keeps running).
func runMachineRemove(args []string) int {
	return runMachineTo(args, "remove", 1, nil)
}

// runMachineDisconnect is "kisui machine disconnect <machine>".
func runMachineDisconnect(args []string) int {
	return runMachineTo(args, "disconnect", 1, nil)
}

// runMachineReconnect is "kisui machine reconnect <machine>": connect again,
// or now when it is waiting to.
func runMachineReconnect(args []string) int {
	return runMachineTo(args, "reconnect", 1, nil)
}

// runMachineTo runs a "kisui machine <cmd> <machine> ..." that takes words
// plain words (the first is the machine) and no flag; fill puts the rest in
// the request.
func runMachineTo(args []string, cmd string, words int, fill func(rq map[string]any, rest []string)) int {
	usage := i18n.T("machine." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, nil)
	if !ok || len(f.rest) != words || strings.TrimSpace(f.rest[0]) == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"machine": f.rest[0]}
	if fill != nil {
		fill(rq, f.rest)
	}
	return windowRun("machine "+cmd, "machine."+cmd, rq, nil)
}

// runMachineTerminal is "kisui machine terminal <machine> [--start-dir <path>]
// [--shell <path>] [--unset-start-dir] [--unset-shell]": the terminal settings
// of the machine dialog (t). With no flag it prints them; a flag changes that
// one and keeps the other. It prints them as they are then.
func runMachineTerminal(args []string) int {
	usage := i18n.T("machine.terminal.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--start-dir", "--shell"}, []string{"--unset-start-dir", "--unset-shell"})
	if !ok || len(f.rest) != 1 || strings.TrimSpace(f.rest[0]) == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	_, setDir := f.value["--start-dir"]
	_, setShell := f.value["--shell"]
	if (setDir && f.on["--unset-start-dir"]) || (setShell && f.on["--unset-shell"]) {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"machine": f.rest[0]}
	if setDir {
		rq["startDir"] = f.value["--start-dir"]
	}
	if setShell {
		rq["shell"] = f.value["--shell"]
	}
	if f.on["--unset-start-dir"] {
		rq["unsetStartDir"] = true
	}
	if f.on["--unset-shell"] {
		rq["unsetShell"] = true
	}
	var out terminalInfo
	if code := windowRun("machine terminal", "machine.terminal", rq, &out); code != 0 {
		return code
	}
	if err := writeTerminalInfo(os.Stdout, out); err != nil {
		fmt.Fprintln(os.Stderr, windowError("machine terminal", err))
		return 1
	}
	return 0
}

// writeTerminalInfo writes the settings a line each, with the names of
// config.toml ("-" for one that is not set).
func writeTerminalInfo(w io.Writer, t terminalInfo) error {
	_, err := io.WriteString(w, alignColumns([][]string{
		{"start_dir", tableCell(t.StartDir)},
		{"shell", tableCell(t.Shell)},
	}))
	return err
}
