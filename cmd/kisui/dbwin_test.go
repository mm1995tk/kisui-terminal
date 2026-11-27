package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The usage is printed for wrong arguments (exit code 2), before anything is asked.
func TestDBWindowUsage(t *testing.T) {
	for _, tc := range []struct {
		run  func([]string) int
		args []string
	}{
		{runDBOpen, []string{}},
		{runDBOpen, []string{"a", "b"}},
		{runDBRefresh, []string{""}},
		{runDBExport, []string{"tab"}},
		{runDBExport, []string{"tab", "--format", "xml"}},
		{runDBHistory, []string{}},
		{runDBPage, []string{"tab"}},
		{runDBPage, []string{"tab", "--next", "--prev"}},
		{runDBView, []string{"tab", "both"}},
		{runDBResult, []string{"tab"}},
		{runDBResult, []string{"tab", "--next", "--close"}},
		{runDBElevateEnd, []string{}},
	} {
		if got := tc.run(tc.args); got != 2 {
			t.Errorf("%v: exit code %d, want 2", tc.args, got)
		}
	}
}

func TestWriteNewFileKeepsAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.csv")
	if err := writeNewFile(path, "a\n"); err != nil {
		t.Fatal(err)
	}
	if err := writeNewFile(path, "b\n"); err == nil {
		t.Fatal("a file that exists must not be replaced")
	}
	if b, _ := os.ReadFile(path); string(b) != "a\n" {
		t.Errorf("the file changed: %q", b)
	}
}

func TestWriteDBHistory(t *testing.T) {
	var out, errw strings.Builder
	err := writeDBHistory(&out, &errw, []dbHistoryEntry{{SQL: "SELECT 1\nFROM t", At: "x", OK: true, Actor: "agent"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `SELECT 1\nFROM t`) || !strings.Contains(out.String(), "agent") {
		t.Errorf("one line per statement, with who ran it: %q", out.String())
	}
}
