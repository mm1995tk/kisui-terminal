package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

func TestWriteMachineList(t *testing.T) {
	list := []machineInfo{
		{Name: "local", Connected: true, Status: "Connected", TerminalTabs: 2},
		{Name: "dev", SSH: "dev-vm", Status: "Not connected", TerminalTabs: 0, Fixed: true},
	}
	var b strings.Builder
	if err := writeMachineList(&b, list); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("a header and a line for each machine:\n%s", b.String())
	}
	if got := strings.Join(strings.Fields(lines[1]), " "); got != "local - "+i18n.T("machine.list.up")+" 2 - Connected" {
		t.Errorf("the line of the computer of the window: %q", got)
	}
	if got := strings.Join(strings.Fields(lines[2]), " "); got != "dev dev-vm "+i18n.T("machine.list.down")+" 0 config.toml Not connected" {
		t.Errorf("a machine only in config.toml: %q", got)
	}

	b.Reset()
	if err := writeMachineListJSON(&b, nil); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Machines []machineInfo `json:"machines"`
	}
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil || got.Machines == nil {
		t.Fatalf("no machines must be an empty list: %q %v", b.String(), err)
	}
}

func TestWriteTerminalInfo(t *testing.T) {
	var b strings.Builder
	if err := writeTerminalInfo(&b, terminalInfo{StartDir: "~/work"}); err != nil {
		t.Fatal(err)
	}
	if got := b.String(); got != "start_dir  ~/work\nshell      -\n" {
		t.Errorf("%q", got)
	}
}

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestMachineUsage(t *testing.T) {
	for _, tc := range []struct {
		run  func([]string) int
		args []string
	}{
		{runMachineList, []string{"extra"}},
		{runMachineAdd, []string{}},
		{runMachineAdd, []string{" "}},
		{runMachineAdd, []string{"a", "b"}},
		{runMachineAdd, []string{"--name"}},
		{runMachineRename, []string{"a"}},
		{runMachineRename, []string{"", "b"}},
		{runMachineRemove, []string{}},
		{runMachineRemove, []string{"--force", "a"}},
		{runMachineDisconnect, []string{"a", "b"}},
		{runMachineReconnect, []string{""}},
		{runMachineTerminal, []string{}},
		{runMachineTerminal, []string{"a", "--start-dir"}},
		{runMachineTerminal, []string{"a", "--start-dir", "~", "--unset-start-dir"}},
		{runMachineTerminal, []string{"a", "--shell", "/bin/sh", "--unset-shell"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%q: exit code %d, want 2", tc.args, code)
		}
	}
}
