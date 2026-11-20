package db

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
)

func TestHistory(t *testing.T) {
	dir := t.TempDir()
	h := &History{Dir: dir}
	at := time.Date(2026, 1, 2, 3, 4, 5, 678_900_000, time.FixedZone("JST", 9*60*60))
	add := func(h *History, name, sql string, ok bool) {
		t.Helper()
		if err := h.Add(name, HistoryEntry{SQL: sql, At: at, OK: ok}); err != nil {
			t.Fatal(err)
		}
		at = at.Add(time.Second)
	}
	add(h, "prod", "SELECT 1", true)
	add(h, "dev", "DELETE FROM t", true)
	add(h, "prod", "SELEC 2", false)
	add(h, "Prod", "SELECT 3", true) // another connection, though only the case differs

	// A new History on the same folder (kisui serve started again) reads the same.
	h = &History{Dir: dir}
	got, err := h.List("prod", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].SQL != "SELEC 2" || got[0].OK || got[1].SQL != "SELECT 1" || !got[1].OK {
		t.Errorf("prod: %+v", got)
	}
	if want := time.Date(2026, 1, 1, 18, 4, 5, 678_000_000, time.UTC); !got[1].At.Equal(want) || got[1].At.Location() != time.UTC {
		t.Errorf("at: %v", got[1].At)
	}
	if got, _ := h.List("dev", 0); len(got) != 1 || got[0].SQL != "DELETE FROM t" {
		t.Errorf("dev: %+v", got)
	}
	if got, _ := h.List("Prod", 0); len(got) != 1 || got[0].SQL != "SELECT 3" {
		t.Errorf("Prod: %+v", got)
	}
	if got, _ := h.List("prod", 1); len(got) != 1 || got[0].SQL != "SELEC 2" {
		t.Errorf("limit: %+v", got)
	}
	if got, err := h.List("none", 0); err != nil || got == nil || len(got) != 0 {
		t.Errorf("no history: %+v, %v", got, err)
	}

	// The files are the user's only, and the names do not show the connection.
	files, _ := os.ReadDir(dir)
	if len(files) != 3 {
		t.Errorf("files: %v", files)
	}
	for _, f := range files {
		fi, _ := f.Info()
		if fi.Mode().Perm() != 0o600 || !strings.HasSuffix(f.Name(), ".jsonl") || strings.Contains(f.Name(), "prod") {
			t.Errorf("file %s: %v", f.Name(), fi.Mode())
		}
	}
	line, _ := os.ReadFile(h.historyFile("dev"))
	if string(line) != `{"sql":"DELETE FROM t","at":"2026-01-01T18:04:06.678Z","ok":true}`+"\n" {
		t.Errorf("file: %s", line)
	}
}

func TestHistoryLimits(t *testing.T) {
	h := &History{Dir: t.TempDir()}
	at := time.Now()
	for i := range MaxHistoryEntries + 5 {
		if err := h.Add("c", HistoryEntry{SQL: "SELECT " + strings.Repeat("x", i%7), At: at.Add(time.Duration(i) * time.Second), OK: true}); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := h.List("c", 0)
	if len(got) != MaxHistoryEntries || !got[0].At.After(got[1].At) {
		t.Errorf("%d entries", len(got))
	}
	// Too long a statement is not kept, and does not push the others out.
	if err := h.Add("c", HistoryEntry{SQL: strings.Repeat("y", MaxHistorySQL+1), At: at}); err != nil {
		t.Fatal(err)
	}
	if got2, _ := h.List("c", 0); len(got2) != MaxHistoryEntries || got2[0] != got[0] {
		t.Errorf("after a long statement: %d entries", len(got2))
	}
	// The bytes are limited too.
	big := strings.Repeat("z", MaxHistorySQL)
	for range maxHistoryBytes/MaxHistorySQL + 3 {
		if err := h.Add("big", HistoryEntry{SQL: big, At: at}); err != nil {
			t.Fatal(err)
		}
	}
	fi, err := os.Stat(h.historyFile("big"))
	if err != nil || fi.Size() > maxHistoryBytes {
		t.Errorf("size: %v, %v", fi.Size(), err)
	}
	if got, _ := h.List("big", 0); len(got) < maxHistoryBytes/MaxHistorySQL-2 {
		t.Errorf("big: %d entries", len(got))
	}
}

// A broken line, and a line longer than any the history writes, is skipped;
// the rest stays.
func TestHistoryBrokenLine(t *testing.T) {
	h := &History{Dir: t.TempDir()}
	if err := os.WriteFile(h.historyFile("c"), []byte(`{"sql":"SELECT 1","at":"2026-01-01T00:00:00Z","ok":true}`+"\n{broken\n"+strings.Repeat("x", maxHistoryBytes+10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.Add("c", HistoryEntry{SQL: "SELECT 2", At: time.Now(), OK: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.List("c", 0); len(got) != 2 || got[0].SQL != "SELECT 2" || got[1].SQL != "SELECT 1" {
		t.Errorf("%+v", got)
	}
}

// With no folder nothing is kept.
func TestHistoryNoDir(t *testing.T) {
	h := &History{}
	if err := h.Add("c", HistoryEntry{SQL: "SELECT 1"}); err != nil {
		t.Fatal(err)
	}
	if got, err := h.List("c", 0); err != nil || len(got) != 0 {
		t.Errorf("%+v, %v", got, err)
	}
}

// A variant has a history of its own: apart from the other variants, and
// from a connection without variants that has the same name.
func TestHistoryKey(t *testing.T) {
	plain := config.DBConnection{Name: "shop"}
	local, prod := plain, plain
	local.Variant, prod.Variant = "local", "prod"
	if got := HistoryKey(plain); got != "shop" {
		t.Errorf("without a variant: %q", got)
	}
	h := &History{Dir: t.TempDir()}
	for _, c := range []config.DBConnection{plain, local, prod} {
		if err := h.Add(HistoryKey(c), HistoryEntry{SQL: "SELECT '" + c.Variant + "'", At: time.Now(), OK: true}); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []config.DBConnection{plain, local, prod} {
		got, err := h.List(HistoryKey(c), 0)
		if err != nil || len(got) != 1 || got[0].SQL != "SELECT '"+c.Variant+"'" {
			t.Errorf("%q: %+v, %v", c.Variant, got, err)
		}
	}
}
