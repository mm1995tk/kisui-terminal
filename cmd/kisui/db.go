package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

// The "kisui db" commands are how a coding agent reaches the database
// connections of the machine it runs on: the "kisui serve" of the pane
// connects, as it does for a database tab of the window. Every request is the
// agent's, so the agent's permission on the connection (docs/database.md)
// decides what runs. The commands never ask for a password and never take one:
// an agent would have to write it on the command line.

// dbDefaultRows is how many rows "kisui db query" asks for without --max-rows:
// fewer than the window (1000), because an agent reads every row it gets.
const dbDefaultRows = 100

// dbMaxRows is the most rows "kisui serve" gives (db.query's maxRows).
const dbMaxRows = db.MaxMaxRows

// dbProposeTimeout is how long "kisui db propose" waits: a little longer than
// "kisui serve" waits for the person at the window (server.dbProposeWait), so
// that its answer, not a timeout of the socket, is what the command prints.
const dbProposeTimeout = 100 * time.Second

// dbArgs is what parseDB reads.
type dbArgs struct {
	variant string
	asJSON  bool
	maxRows int // 0: not given
	rest    []string
}

// parseDB reads the arguments of a "kisui db" command: the flags in allowed
// ("--json", "--variant", "--max-rows"; each at most once, a flag with a value
// also as --flag=value) before or between the other words, which it returns in
// rest. After "--" every word is one of the other words; "-" is one too (the
// SQL from stdin). It reports false for anything else.
func parseDB(args []string, allowed ...string) (dbArgs, bool) {
	var a dbArgs
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		w := args[i]
		if w == "--" {
			a.rest = append(a.rest, args[i+1:]...)
			break
		}
		if w == "-" || !strings.HasPrefix(w, "-") {
			a.rest = append(a.rest, w)
			continue
		}
		flag, value, inline := strings.Cut(w, "=")
		ok := false
		for _, f := range allowed {
			ok = ok || f == flag
		}
		if !ok || seen[flag] {
			return dbArgs{}, false
		}
		seen[flag] = true
		if flag == "--json" {
			if inline {
				return dbArgs{}, false
			}
			a.asJSON = true
			continue
		}
		if !inline {
			if i+1 >= len(args) {
				return dbArgs{}, false
			}
			i++
			value = args[i]
		}
		switch flag {
		case "--variant":
			if strings.TrimSpace(value) == "" {
				return dbArgs{}, false
			}
			a.variant = value
		case "--max-rows":
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > dbMaxRows {
				return dbArgs{}, false
			}
			a.maxRows = n
		}
	}
	return a, true
}

// dbCommand runs one "kisui db <name>": it prints the usage for -h, reads the
// arguments with parse (false: a usage error), sends the request and hands the
// reply to done. wait is how long it waits for the reply (0: no limit). It
// returns the process exit code.
func dbCommand(name string, args []string, wait time.Duration, parse func() (panecmd.Request, bool), done func(panecmd.Reply) error) int {
	usage := i18n.T("db." + name + ".usage")
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(usage)
		return 0
	}
	rq, ok := parse()
	if !ok {
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	pane, err := panecmd.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, i18n.T("pane.outside"))
		return 1
	}
	if rq.SQL == "-" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("db.failed")+"\n", name, err)
			return 1
		}
		rq.SQL = string(b)
	}
	r, err := pane.DoWithin(rq, wait)
	if err == nil {
		err = done(r)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, dbError(name, r.Code, err))
		return 1
	}
	return 0
}

// dbError is the text of a failure of "kisui db <name>". For the failures an
// agent cannot get around by itself, a second line says what to do instead.
func dbError(name, code string, err error) string {
	var text string
	switch {
	case errors.Is(err, panecmd.ErrNotInPane):
		text = i18n.T("pane.outside")
	case errors.Is(err, panecmd.ErrNoServer):
		text = fmt.Sprintf(i18n.T("pane.noserve"), err)
	default:
		text = fmt.Sprintf(i18n.T("db.failed"), name, err)
	}
	switch code {
	case panecmd.CodeDenied:
		if name == "propose" {
			return text + "\n" + i18n.T("db.hint.deniedPropose")
		}
		return text + "\n" + i18n.T("db.hint.denied")
	case panecmd.CodePasswordRequired:
		return text + "\n" + i18n.T("db.hint.password")
	case panecmd.CodeNotFound:
		return text + "\n" + i18n.T("db.hint.notFound")
	}
	return text
}

// runDBConnections is "kisui db connections [--json]": the database
// connections in the settings of the machine of the pane, one line for each
// (for each variant of a connection with variants), with what a coding agent
// may do on it. --json prints the result of db.connections.
func runDBConnections(args []string) int {
	var a dbArgs
	return dbCommand("connections", args, panecmd.Timeout, func() (panecmd.Request, bool) {
		var ok bool
		a, ok = parseDB(args, "--json")
		return panecmd.Request{Cmd: "db-connections"}, ok && len(a.rest) == 0
	}, func(r panecmd.Reply) error {
		if a.asJSON {
			return writeDBJSON(os.Stdout, r.DB)
		}
		var res dbConnections
		if err := json.Unmarshal(r.DB, &res); err != nil {
			return err
		}
		return writeDBConnections(os.Stdout, os.Stderr, res)
	})
}

// dbConnections is what "kisui db connections" reads of the result of
// db.connections (server.DBConnectionsResult).
type dbConnections struct {
	Connections []struct {
		Name     string `json:"name"`
		Variant  string `json:"variant"`
		Kind     string `json:"kind"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Database string `json:"database"`
		Agent    struct {
			Run     string `json:"run"`
			Propose bool   `json:"propose"`
			// Elevated is there while the user has strengthened the permission
			// of the agent for a time.
			Elevated *struct {
				RemainingSeconds int64 `json:"remainingSeconds"`
			} `json:"elevated"`
		} `json:"agent"`
	} `json:"connections"`
	Problems []string `json:"problems"`
}

// writeDBConnections writes the connections as a table to w, and the mistakes
// of the settings (and that there is no connection) to errw.
func writeDBConnections(w, errw io.Writer, res dbConnections) error {
	for _, p := range res.Problems {
		fmt.Fprintln(errw, p)
	}
	if len(res.Connections) == 0 {
		fmt.Fprintln(errw, i18n.T("db.connections.none"))
		return nil
	}
	rows := [][]string{strings.Split(i18n.T("db.connections.header"), "\t")}
	for _, c := range res.Connections {
		host := c.Host
		if !strings.HasPrefix(host, "/") { // not a Unix socket
			host += ":" + strconv.Itoa(c.Port)
		}
		propose := "no"
		if c.Agent.Propose {
			propose = "yes"
		}
		elevated := "-"
		if e := c.Agent.Elevated; e != nil {
			elevated = fmt.Sprintf(i18n.T("db.connections.elevated"), dbRemaining(e.RemainingSeconds))
		}
		rows = append(rows, []string{dbCell(c.Name), dbCell(c.Variant), c.Kind, dbCell(host), dbCell(c.Database), c.Agent.Run, propose, elevated})
	}
	_, err := io.WriteString(w, alignColumns(rows))
	return err
}

// dbRemaining is a number of seconds as the time that is left: "45s" under a
// minute, else in minutes, rounded up ("12m", "1h5m").
func dbRemaining(seconds int64) string {
	if seconds < 60 {
		return strconv.FormatInt(max(seconds, 0), 10) + "s"
	}
	m := (seconds + 59) / 60
	if m < 60 {
		return strconv.FormatInt(m, 10) + "m"
	}
	if m%60 == 0 {
		return strconv.FormatInt(m/60, 10) + "h"
	}
	return strconv.FormatInt(m/60, 10) + "h" + strconv.FormatInt(m%60, 10) + "m"
}

// runDBSchema is "kisui db schema [--variant <variant>] [--json] <connection>
// [<table>]": the tables and views of the connection, or, with a table (its
// name, or schema.name), the columns of that table. --json prints the result
// of db.schema (with a table: only that table).
func runDBSchema(args []string) int {
	var a dbArgs
	table := ""
	return dbCommand("schema", args, 0, func() (panecmd.Request, bool) {
		var ok bool
		a, ok = parseDB(args, "--json", "--variant")
		if !ok || len(a.rest) < 1 || len(a.rest) > 2 || a.rest[0] == "" {
			return panecmd.Request{}, false
		}
		if len(a.rest) == 2 {
			if table = a.rest[1]; table == "" {
				return panecmd.Request{}, false
			}
		}
		return panecmd.Request{Cmd: "db-schema", Connection: a.rest[0], Variant: a.variant}, true
	}, func(r panecmd.Reply) error {
		var cat db.Catalog
		if err := json.Unmarshal(r.DB, &cat); err != nil {
			return err
		}
		if table != "" {
			if cat = tablesNamed(cat, table); len(cat.Schemas) == 0 {
				return fmt.Errorf(i18n.T("db.schema.noTable"), table)
			}
		}
		if cat.Truncated {
			fmt.Fprintln(os.Stderr, i18n.T("db.schema.truncated"))
		}
		if a.asJSON {
			b, err := json.Marshal(cat)
			if err != nil {
				return err
			}
			return writeDBJSON(os.Stdout, b)
		}
		if table != "" {
			return writeDBColumns(os.Stdout, cat)
		}
		return writeDBTables(os.Stdout, cat)
	})
}

// tablesNamed is cat with only the tables named name: "table" (of any schema)
// or "schema.table". A schema without such a table is left out.
func tablesNamed(cat db.Catalog, name string) db.Catalog {
	out := db.Catalog{Truncated: cat.Truncated}
	for _, s := range cat.Schemas {
		var tables []db.CatalogTable
		for _, t := range s.Tables {
			if t.Name == name || s.Name+"."+t.Name == name {
				tables = append(tables, t)
			}
		}
		if len(tables) > 0 {
			out.Schemas = append(out.Schemas, db.CatalogSchema{Name: s.Name, Tables: tables})
		}
	}
	return out
}

// writeDBTables writes one line for each table of cat: its schema, name, kind
// and number of columns.
func writeDBTables(w io.Writer, cat db.Catalog) error {
	rows := [][]string{strings.Split(i18n.T("db.schema.header"), "\t")}
	for _, s := range cat.Schemas {
		for _, t := range s.Tables {
			rows = append(rows, []string{dbCell(s.Name), dbCell(t.Name), string(t.Kind), strconv.Itoa(len(t.Columns))})
		}
	}
	_, err := io.WriteString(w, alignColumns(rows))
	return err
}

// writeDBColumns writes each table of cat as a line "schema.table (kind)" and
// its columns under it, name and type.
func writeDBColumns(w io.Writer, cat db.Catalog) error {
	var b strings.Builder
	for _, s := range cat.Schemas {
		for _, t := range s.Tables {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			fmt.Fprintf(&b, "%s.%s (%s)\n", dbCell(s.Name), dbCell(t.Name), t.Kind)
			rows := make([][]string, len(t.Columns))
			for i, c := range t.Columns {
				rows[i] = []string{"", dbCell(c.Name), dbCell(c.Type)}
			}
			b.WriteString(alignColumns(rows, 1))
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// runDBQuery is "kisui db query [--variant <variant>] [--max-rows <n>] [--json]
// <connection> <sql|->": run one statement on the connection, as the coding
// agent, and print its rows as a table. --json prints the result of db.query.
// It waits as long as the statement runs; ending the command ends the
// statement.
func runDBQuery(args []string) int {
	var a dbArgs
	return dbCommand("query", args, 0, func() (panecmd.Request, bool) {
		var ok bool
		a, ok = parseDB(args, "--json", "--variant", "--max-rows")
		if !ok || len(a.rest) != 2 || a.rest[0] == "" || a.rest[1] == "" {
			return panecmd.Request{}, false
		}
		if a.maxRows == 0 {
			a.maxRows = dbDefaultRows
		}
		return panecmd.Request{Cmd: "db-query", Connection: a.rest[0], Variant: a.variant, SQL: a.rest[1], MaxRows: a.maxRows}, true
	}, func(r panecmd.Reply) error {
		if a.asJSON {
			return writeDBJSON(os.Stdout, r.DB)
		}
		var res db.Result
		if err := json.Unmarshal(r.DB, &res); err != nil {
			return err
		}
		return writeDBResult(os.Stdout, os.Stderr, res)
	})
}

// writeDBResult writes the rows of res as a table to w (for a statement that
// gives no rows: how many rows it changed), and to errw what the table does
// not show: that there are more rows, or that a value was cut.
func writeDBResult(w, errw io.Writer, res db.Result) error {
	if len(res.Columns) == 0 {
		var err error
		if res.RowsAffected != nil {
			_, err = fmt.Fprintf(w, i18n.T("db.query.changed")+"\n", *res.RowsAffected)
		} else {
			_, err = fmt.Fprintln(w, i18n.T("db.query.done"))
		}
		return err
	}
	rows := make([][]string, 0, len(res.Rows)+1)
	head := make([]string, len(res.Columns))
	for i, c := range res.Columns {
		head[i] = dbCell(c.Name)
	}
	rows = append(rows, head)
	for _, r := range res.Rows {
		line := make([]string, len(r))
		for i, v := range r {
			if v == nil {
				line[i] = "NULL"
			} else {
				line[i] = dbValue(*v)
			}
		}
		rows = append(rows, line)
	}
	if _, err := io.WriteString(w, alignColumns(rows)); err != nil {
		return err
	}
	if res.Truncated {
		fmt.Fprintf(errw, i18n.T("db.query.more")+"\n", len(res.Rows))
	} else {
		fmt.Fprintf(errw, i18n.T("db.query.rows")+"\n", len(res.Rows))
	}
	if res.TruncatedCells {
		fmt.Fprintln(errw, i18n.T("db.query.cells"))
	}
	return nil
}

// runDBPropose is "kisui db propose [--variant <variant>] <connection>
// <sql|->": write the SQL into the input of a database tab of the window, for
// the user to read and run. When the input already holds SQL, the window asks
// the user first; their "no" is a failure.
func runDBPropose(args []string) int {
	return dbCommand("propose", args, dbProposeTimeout, func() (panecmd.Request, bool) {
		a, ok := parseDB(args, "--variant")
		if !ok || len(a.rest) != 2 || a.rest[0] == "" || a.rest[1] == "" {
			return panecmd.Request{}, false
		}
		return panecmd.Request{Cmd: "db-propose", Connection: a.rest[0], Variant: a.variant, SQL: a.rest[1]}, true
	}, func(panecmd.Reply) error {
		_, err := fmt.Println(i18n.T("db.propose.done"))
		return err
	})
}

// writeDBJSON writes the JSON b indented, as "kisui pane list --json" does.
func writeDBJSON(w io.Writer, b []byte) error {
	var out bytes.Buffer
	if err := json.Indent(&out, b, "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	_, err := w.Write(out.Bytes())
	return err
}

// dbCell is a name for a column of a table: control characters become spaces,
// and empty is "-".
func dbCell(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

// dbValue is a value of a row for a column of a table. A line break, a tab and
// a backslash are written as \n, \t and \\ (and other control characters as
// \u00XX), so that a row stays one line and its columns stay apart; --json has
// the values as they are.
func dbValue(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r == '\\' || unicode.IsControl(r) }) {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\r':
			b.WriteString(`\r`)
		case unicode.IsControl(r):
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
