package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// The "kisui db" commands that act on a database tab of the window (open,
// refresh, export, history, page, view, result, elevate-end). The window owns
// the tabs, so each one asks the window (window.go), as "kisui tab" does;
// <tab> is the id or the name of a tab ("kisui tab list" prints them). They
// do what the keys of the database tab do. "kisui db connections", "schema",
// "query" and "propose" go to "kisui serve" directly (db.go) and stay as they
// are. There is no command that elevates a permission: only the person at
// the window does (docs/database.md); "elevate-end" ends an elevation.

// runDBOpen is "kisui db open [--variant <variant>] [--workspace <name|id>]
// <connection>": open a database tab of a connection of this machine, in the
// workspace of this pane (or --workspace), and print its id.
func runDBOpen(args []string) int {
	usage := i18n.T("db.open.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--variant", "--workspace"}, nil)
	if !ok || len(f.rest) != 1 || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"connection": f.rest[0]}
	if v, ok := f.value["--variant"]; ok {
		rq["variant"] = v
	}
	if w, ok := f.value["--workspace"]; ok {
		rq["workspace"] = w
	}
	var out struct {
		ID string `json:"id"`
	}
	if code := windowRun("db open", "db.open", rq, &out); code != 0 {
		return code
	}
	fmt.Println(out.ID)
	return 0
}

// dbTabCommand runs a "kisui db <cmd> <tab> ..." that acts on one database
// tab: args has the flags of toggle and exactly words plain words (the first
// is the tab), and fill puts the rest in the request (false: the usage).
func dbTabCommand(args []string, cmd, command string, toggle []string, words int, fill func(rq map[string]any, f flags) bool, out any) int {
	usage := i18n.T("db." + cmd + ".usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, toggle)
	if !ok || len(f.rest) != words || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	rq := map[string]any{"tab": f.rest[0]}
	if !fill(rq, f) {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	return windowRun("db "+cmd, command, rq, out)
}

// runDBRefresh is "kisui db refresh <tab>": ask again for the tables of the
// connection, and for the structure of the chosen table.
func runDBRefresh(args []string) int {
	return dbTabCommand(args, "refresh", "db.refresh", nil, 1, func(map[string]any, flags) bool { return true }, nil)
}

// runDBPage is "kisui db page <tab> --next|--prev": the next or the previous
// page of the result that the tab shows. It does not wait for the page.
func runDBPage(args []string) int {
	return dbTabCommand(args, "page", "db.page", []string{"--next", "--prev"}, 1, func(rq map[string]any, f flags) bool {
		if f.on["--next"] == f.on["--prev"] {
			return false
		}
		rq["dir"] = map[bool]string{true: "next", false: "prev"}[f.on["--next"]]
		return true
	}, nil)
}

// runDBView is "kisui db view <tab> data|structure": what the result area of
// the tab shows, for a result of a table that was chosen in the schema tree.
func runDBView(args []string) int {
	return dbTabCommand(args, "view", "db.view", nil, 2, func(rq map[string]any, f flags) bool {
		if f.rest[1] != "data" && f.rest[1] != "structure" {
			return false
		}
		rq["view"] = f.rest[1]
		return true
	}, nil)
}

// runDBResult is "kisui db result <tab> --next|--prev|--close": show the next
// or the previous result tab of the database tab, or close the one it shows.
func runDBResult(args []string) int {
	var out struct {
		Moved bool `json:"moved"`
	}
	to := ""
	code := dbTabCommand(args, "result", "db.result", []string{"--next", "--prev", "--close"}, 1, func(rq map[string]any, f flags) bool {
		for _, w := range []string{"next", "prev", "close"} {
			if f.on["--"+w] {
				if to != "" {
					return false
				}
				to = w
			}
		}
		if to == "" {
			return false
		}
		rq["to"] = to
		return true
	}, &out)
	if code == 0 && !out.Moved { // the keys do nothing at the end either
		fmt.Fprintln(os.Stderr, i18n.T("db.result.edge"))
	}
	return code
}

// runDBElevateEnd is "kisui db elevate-end <tab>": end the elevated
// permissions of the connection of the tab at once (the person's and the
// agent's, as the key does). There is no command to elevate.
func runDBElevateEnd(args []string) int {
	var out struct {
		Ended string `json:"ended"`
	}
	code := dbTabCommand(args, "elevate-end", "db.elevateEnd", nil, 1, func(map[string]any, flags) bool { return true }, &out)
	if code == 0 {
		fmt.Printf(i18n.T("db.elevateEnd.done")+"\n", out.Ended)
	}
	return code
}

// runDBExport is "kisui db export <tab> --format csv|tsv|json [--out <file>]":
// the result that the tab shows, as text, to stdout or to a new file. It
// refuses to replace a file that exists.
func runDBExport(args []string) int {
	usage := i18n.T("db.export.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, []string{"--format", "--out"}, nil)
	format := f.value["--format"]
	if !ok || len(f.rest) != 1 || f.rest[0] == "" || (format != "csv" && format != "tsv" && format != "json") {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		Text           string `json:"text"`
		Rows           int    `json:"rows"`
		Truncated      bool   `json:"truncated"`
		TruncatedCells bool   `json:"truncatedCells"`
	}
	if code := windowRun("db export", "db.export", map[string]any{"tab": f.rest[0], "format": format}, &out); code != 0 {
		return code
	}
	if path, ok := f.value["--out"]; ok {
		if err := writeNewFile(path, out.Text); err != nil {
			fmt.Fprintln(os.Stderr, windowError("db export", err))
			return 1
		}
		fmt.Fprintf(os.Stderr, i18n.T("db.export.saved")+"\n", out.Rows, path)
	} else if _, err := io.WriteString(os.Stdout, out.Text); err != nil {
		fmt.Fprintln(os.Stderr, windowError("db export", err))
		return 1
	}
	if out.Truncated {
		fmt.Fprintln(os.Stderr, i18n.T("db.export.truncated"))
	}
	if out.TruncatedCells {
		fmt.Fprintln(os.Stderr, i18n.T("db.export.truncatedCells"))
	}
	return 0
}

// writeNewFile writes text to a new file (mode 0600). A file that exists is
// not replaced.
func writeNewFile(path, text string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf(i18n.T("db.export.exists"), path)
		}
		return err
	}
	if _, err := io.WriteString(f, text); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// dbHistoryEntry is one statement of the answer to "db.history".
type dbHistoryEntry struct {
	SQL   string `json:"sql"`
	At    string `json:"at"`
	OK    bool   `json:"ok"`
	Actor string `json:"actor,omitempty"`
}

// runDBHistory is "kisui db history <tab> [--json]": the statements run on the
// connection of the tab, newest first.
func runDBHistory(args []string) int {
	usage := i18n.T("db.history.usage")
	if isHelp(args) {
		fmt.Println(usage)
		return 0
	}
	f, ok := parseFlags(args, nil, []string{"--json"})
	if !ok || len(f.rest) != 1 || f.rest[0] == "" {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	var out struct {
		Entries []dbHistoryEntry `json:"entries"`
	}
	if code := windowRun("db history", "db.history", map[string]any{"tab": f.rest[0]}, &out); code != 0 {
		return code
	}
	var err error
	if f.on["--json"] {
		err = writeDBHistoryJSON(os.Stdout, out.Entries)
	} else {
		err = writeDBHistory(os.Stdout, os.Stderr, out.Entries)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, windowError("db history", err))
		return 1
	}
	return 0
}

// writeDBHistoryJSON writes the entries as {"entries": [...]}, none as [].
func writeDBHistoryJSON(w io.Writer, entries []dbHistoryEntry) error {
	if entries == nil {
		entries = []dbHistoryEntry{}
	}
	e := json.NewEncoder(w)
	e.SetIndent("", "  ")
	return e.Encode(struct {
		Entries []dbHistoryEntry `json:"entries"`
	}{entries})
}

// writeDBHistory writes a line for each statement: when (local time), whether
// the database ran it, who ("agent" or "-"), and the SQL (dbValue keeps a
// statement on one line).
func writeDBHistory(w, errw io.Writer, entries []dbHistoryEntry) error {
	if len(entries) == 0 {
		fmt.Fprintln(errw, i18n.T("db.history.none"))
		return nil
	}
	rows := [][]string{strings.Split(i18n.T("db.history.header"), "\t")}
	for _, e := range entries {
		at := e.At
		if t, err := time.Parse(time.RFC3339Nano, e.At); err == nil {
			at = t.Local().Format("2006-01-02 15:04:05")
		}
		ok := "no"
		if e.OK {
			ok = "yes"
		}
		who := "-"
		if e.Actor != "" {
			who = dbCell(e.Actor)
		}
		rows = append(rows, []string{at, ok, who, dbValue(e.SQL)})
	}
	_, err := io.WriteString(w, alignColumns(rows))
	return err
}
