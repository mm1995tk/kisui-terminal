package main

import "testing"

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestPaneWindowUsage(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  func([]string) int
		args []string
	}{
		{"focus none", runPaneFocus, []string{}},
		{"focus two", runPaneFocus, []string{"a", "b"}},
		{"focus empty", runPaneFocus, []string{""}},
		{"focus last with a pane", runPaneFocus, []string{"--last", "a"}},
		{"focus last with machine", runPaneFocus, []string{"--last", "--machine", "dev"}},
		{"focus unknown flag", runPaneFocus, []string{"--bogus", "a"}},
		{"swap no direction", runPaneSwap, []string{"a"}},
		{"swap two directions", runPaneSwap, []string{"a", "--left", "--up"}},
		{"swap no pane", runPaneSwap, []string{"--left"}},
		{"zoom none", runPaneZoom, []string{}},
		{"zoom direction", runPaneZoom, []string{"a", "--left"}},
		{"resize no number", runPaneResize, []string{"a", "--right"}},
		{"resize zero", runPaneResize, []string{"a", "--right", "0"}},
		{"resize too many", runPaneResize, []string{"a", "--right", "51"}},
		{"resize not a number", runPaneResize, []string{"a", "--right", "x"}},
		{"resize padded number", runPaneResize, []string{"a", "--right", "05"}},
		{"resize no direction", runPaneResize, []string{"a", "3"}},
	} {
		if code := tc.run(tc.args); code != 2 {
			t.Errorf("%s: exit code %d, want 2", tc.name, code)
		}
	}
}

func TestPaneArgs(t *testing.T) {
	f, ok := parseFlags([]string{"--machine", "dev", "worker", "--left"}, []string{"--machine"}, paneDirs)
	if !ok {
		t.Fatal("parse")
	}
	if dir, ok := paneDirOf(f); !ok || dir != "left" {
		t.Errorf("direction: %q %v", dir, ok)
	}
	a := paneArgs(f, map[string]any{"dir": "left"})
	if a["pane"] != "worker" || a["machine"] != "dev" || a["dir"] != "left" || len(a) != 3 {
		t.Errorf("args: %v", a)
	}
}
