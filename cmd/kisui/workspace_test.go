package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

func TestWriteWorkspaceList(t *testing.T) {
	list := []workspaceInfo{
		{ID: "gabcdefghij", Name: "作業用", Tabs: 3, Current: true, Self: true},
		{ID: "gklmnopqrst", Name: "empty", Tabs: 0},
	}
	var b strings.Builder
	if err := writeWorkspaceList(&b, list); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("a header and a line for each workspace:\n%s", b.String())
	}
	if got := strings.Fields(lines[1]); strings.Join(got, " ") != "* gabcdefghij 作業用 3 "+i18n.T("workspace.list.current") {
		t.Errorf("the line of the own workspace: %q", lines[1])
	}
	if got := strings.Fields(lines[2]); strings.Join(got, " ") != "gklmnopqrst empty 0 -" {
		t.Errorf("a workspace with no tab is listed: %q", lines[2])
	}

	b.Reset()
	if err := writeWorkspaceListJSON(&b, nil); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Workspaces []workspaceInfo `json:"workspaces"`
	}
	if err := json.Unmarshal([]byte(b.String()), &got); err != nil || got.Workspaces == nil {
		t.Fatalf("no workspaces must be an empty list: %q %v", b.String(), err)
	}
}

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestWorkspaceUsage(t *testing.T) {
	for _, tc := range []struct {
		run  func([]string) int
		args []string
	}{
		{runWorkspaceList, []string{"extra"}},
		{runWorkspaceNew, []string{}},
		{runWorkspaceNew, []string{"a", "b"}},
		{runWorkspaceRename, []string{"a"}},
		{runWorkspaceRename, []string{"", "b"}},
		{runWorkspaceClose, []string{}},
		{runWorkspaceClose, []string{"--bogus", "a"}},
		{runWorkspaceShow, []string{""}},
		{runWorkspaceMove, []string{"a"}},
		{runWorkspaceMove, []string{"a", "--up", "--down"}},
		{runWorkspaceMove, []string{"a", "--workspace", "w"}},
		{runWorkspaceMove, []string{"--up"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%q: exit code %d, want 2", tc.args, code)
		}
	}
}
