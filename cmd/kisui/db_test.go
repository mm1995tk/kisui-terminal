package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
)

func TestParseDB(t *testing.T) {
	all := []string{"--json", "--variant", "--max-rows"}
	for _, tc := range []struct {
		args    []string
		allowed []string
		want    dbArgs
		ok      bool
	}{
		{nil, all, dbArgs{}, true},
		{[]string{"shop", "SELECT 1"}, all, dbArgs{rest: []string{"shop", "SELECT 1"}}, true},
		{[]string{"--variant", "prod", "--json", "shop", "SELECT 1"}, all, dbArgs{variant: "prod", asJSON: true, rest: []string{"shop", "SELECT 1"}}, true},
		{[]string{"shop", "--variant=prod", "--max-rows=5", "-"}, all, dbArgs{variant: "prod", maxRows: 5, rest: []string{"shop", "-"}}, true},
		{[]string{"shop", "--max-rows", "10000", "x"}, all, dbArgs{maxRows: 10000, rest: []string{"shop", "x"}}, true},
		// after "--", a word that starts with "-" is not a flag (an SQL comment)
		{[]string{"shop", "--", "-- a comment\nSELECT 1", "--json"}, all, dbArgs{rest: []string{"shop", "-- a comment\nSELECT 1", "--json"}}, true},
		{[]string{"--json"}, []string{"--json"}, dbArgs{asJSON: true}, true},
		{[]string{"--variant", "prod"}, []string{"--json"}, dbArgs{}, false},
		{[]string{"--json", "--json"}, all, dbArgs{}, false},
		{[]string{"--json=1"}, all, dbArgs{}, false},
		{[]string{"--variant"}, all, dbArgs{}, false},
		{[]string{"--variant", " "}, all, dbArgs{}, false},
		{[]string{"--max-rows", "0"}, all, dbArgs{}, false},
		{[]string{"--max-rows", "10001"}, all, dbArgs{}, false},
		{[]string{"--max-rows", "x"}, all, dbArgs{}, false},
		{[]string{"--machine", "dev"}, all, dbArgs{}, false},
		{[]string{"-x"}, all, dbArgs{}, false},
	} {
		got, ok := parseDB(tc.args, tc.allowed...)
		if ok != tc.ok || (ok && !reflect.DeepEqual(got, tc.want)) {
			t.Errorf("parseDB(%q) = %+v %v, want %+v %v", tc.args, got, ok, tc.want, tc.ok)
		}
	}
}

// A wrong argument is a usage error (2) before asking anything; the right ones
// outside a pane are an error (1).
func TestRunDBOutsidePane(t *testing.T) {
	t.Setenv(panecmd.EnvSocket, "")
	for _, c := range []struct {
		run  func([]string) int
		args []string
		want int
	}{
		{runDBConnections, nil, 1},
		{runDBConnections, []string{"--json"}, 1},
		{runDBConnections, []string{"shop"}, 2},
		{runDBConnections, []string{"--variant", "a"}, 2},
		{runDBSchema, nil, 2},
		{runDBSchema, []string{"shop"}, 1},
		{runDBSchema, []string{"--variant", "prod", "shop", "public.users"}, 1},
		{runDBSchema, []string{"shop", "a", "b"}, 2},
		{runDBSchema, []string{"--max-rows", "3", "shop"}, 2},
		{runDBQuery, []string{"shop"}, 2},
		{runDBQuery, []string{"shop", ""}, 2},
		{runDBQuery, []string{"shop", "SELECT 1"}, 1},
		{runDBQuery, []string{"--max-rows", "5", "--json", "shop", "SELECT 1"}, 1},
		{runDBQuery, []string{"shop", "SELECT 1", "SELECT 2"}, 2},
		{runDBPropose, []string{"shop"}, 2},
		{runDBPropose, []string{"shop", "SELECT 1"}, 1},
		{runDBPropose, []string{"--json", "shop", "SELECT 1"}, 2},
		{runDBPropose, []string{"--max-rows", "5", "shop", "SELECT 1"}, 2},
	} {
		if got := c.run(c.args); got != c.want {
			t.Errorf("%q: %d, want %d", c.args, got, c.want)
		}
	}
}

func TestWriteDBConnections(t *testing.T) {
	i18n.SetLang("en")
	var res dbConnections
	if err := json.Unmarshal([]byte(`{"connections": [
		{"name": "shop", "variant": "prod", "kind": "postgres", "host": "db.example.com", "port": 5432, "user": "app", "database": "shop", "agent": {"run": "read", "propose": true}},
		{"name": "local", "variant": "", "kind": "mysql", "host": "/run/mysqld/mysqld.sock", "port": 3306, "user": "me", "database": "", "agent": {"run": "none", "propose": false}}
	], "problems": ["config.toml: db.connections[2].kind: must be one of postgres, mysql"]}`), &res); err != nil {
		t.Fatal(err)
	}
	var out, errs bytes.Buffer
	if err := writeDBConnections(&out, &errs, res); err != nil {
		t.Fatal(err)
	}
	want := "" +
		"NAME   VARIANT  KIND      HOST                     DATABASE  RUN   PROPOSE\n" +
		"shop   prod     postgres  db.example.com:5432      shop      read  yes\n" +
		"local  -        mysql     /run/mysqld/mysqld.sock  -         none  no\n"
	if out.String() != want {
		t.Errorf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if !strings.Contains(errs.String(), "db.connections[2].kind") {
		t.Errorf("the problems: %q", errs.String())
	}
	out.Reset()
	errs.Reset()
	if err := writeDBConnections(&out, &errs, dbConnections{}); err != nil || out.Len() != 0 || errs.String() != i18n.T("db.connections.none")+"\n" {
		t.Errorf("no connections: %q %q %v", out.String(), errs.String(), err)
	}
}

func TestWriteDBSchema(t *testing.T) {
	i18n.SetLang("en")
	cat := db.Catalog{Schemas: []db.CatalogSchema{
		{Name: "audit", Tables: []db.CatalogTable{
			{Name: "users", Kind: db.TableKindView, Columns: []db.CatalogColumn{{Name: "id", Type: "integer"}}},
		}},
		{Name: "empty"},
		{Name: "public", Tables: []db.CatalogTable{
			{Name: "orders", Kind: db.TableKindTable, Columns: []db.CatalogColumn{{Name: "id", Type: "bigint"}}},
			{Name: "users", Kind: db.TableKindTable, Columns: []db.CatalogColumn{{Name: "id", Type: "integer"}, {Name: "name", Type: "character varying(20)"}}},
		}},
	}}
	var out bytes.Buffer
	if err := writeDBTables(&out, cat); err != nil {
		t.Fatal(err)
	}
	want := "" +
		"SCHEMA  TABLE   KIND   COLUMNS\n" +
		"audit   users   view   1\n" +
		"public  orders  table  1\n" +
		"public  users   table  2\n"
	if out.String() != want {
		t.Errorf("tables:\n%s\nwant:\n%s", out.String(), want)
	}
	// a bare name is the table of every schema that has it; schema.name is one table
	out.Reset()
	if err := writeDBColumns(&out, tablesNamed(cat, "users")); err != nil {
		t.Fatal(err)
	}
	want = "" +
		"audit.users (view)\n" +
		" id  integer\n" +
		"\n" +
		"public.users (table)\n" +
		" id    integer\n" +
		" name  character varying(20)\n"
	if out.String() != want {
		t.Errorf("columns:\n%s\nwant:\n%s", out.String(), want)
	}
	if got := tablesNamed(cat, "public.users"); len(got.Schemas) != 1 || got.Schemas[0].Name != "public" || len(got.Schemas[0].Tables) != 1 {
		t.Errorf("public.users: %+v", got)
	}
	if got := tablesNamed(cat, "nope"); len(got.Schemas) != 0 {
		t.Errorf("nope: %+v", got)
	}
}

func TestWriteDBResult(t *testing.T) {
	i18n.SetLang("en")
	s := func(v string) *string { return &v }
	var out, notes bytes.Buffer
	res := db.Result{
		Columns:   []db.Column{{Name: "id"}, {Name: "名前"}, {Name: "note"}},
		Rows:      [][]*string{{s("1"), s("あい"), nil}, {s("20"), s(""), s("a\tb\nc\\d\x01")}},
		Truncated: true, TruncatedCells: true,
	}
	if err := writeDBResult(&out, &notes, res); err != nil {
		t.Fatal(err)
	}
	want := "" +
		"id  名前  note\n" +
		"1   あい  NULL\n" +
		"20        a\\tb\\nc\\\\d\\u0001\n"
	if out.String() != want {
		t.Errorf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if got := notes.String(); !strings.Contains(got, "the first 2 rows") || !strings.Contains(got, "1 MiB") {
		t.Errorf("notes: %q", got)
	}
	// a statement that gives no rows: how many rows it changed
	out.Reset()
	notes.Reset()
	n := int64(3)
	if err := writeDBResult(&out, &notes, db.Result{RowsAffected: &n}); err != nil || out.String() != "3 rows changed\n" || notes.Len() != 0 {
		t.Errorf("no rows: %q %q %v", out.String(), notes.String(), err)
	}
	out.Reset()
	if err := writeDBResult(&out, &notes, db.Result{}); err != nil || out.String() != "done\n" {
		t.Errorf("no rows and no count: %q %v", out.String(), err)
	}
	// rows, none cut
	out.Reset()
	notes.Reset()
	if err := writeDBResult(&out, &notes, db.Result{Columns: []db.Column{{Name: "a"}}}); err != nil || out.String() != "a\n" || notes.String() != "(0 rows)\n" {
		t.Errorf("an empty table: %q %q %v", out.String(), notes.String(), err)
	}
}

// A failure the agent cannot get around says what to do instead.
func TestDBError(t *testing.T) {
	i18n.SetLang("en")
	err := errors.New("nope")
	for _, c := range []struct {
		name, code, hint string
	}{
		{"query", panecmd.CodeDenied, i18n.T("db.hint.denied")},
		{"propose", panecmd.CodeDenied, i18n.T("db.hint.deniedPropose")},
		{"schema", panecmd.CodePasswordRequired, i18n.T("db.hint.password")},
		{"query", panecmd.CodeNotFound, i18n.T("db.hint.notFound")},
		{"propose", panecmd.CodeDeclined, ""},
		{"query", "", ""},
	} {
		want := "kisui db " + c.name + ": nope"
		if c.hint != "" {
			want += "\n" + c.hint
		}
		if got := dbError(c.name, c.code, err); got != want {
			t.Errorf("%s %q: %q", c.name, c.code, got)
		}
	}
	if got := dbError("query", "", panecmd.ErrNotInPane); got != i18n.T("pane.outside") {
		t.Errorf("outside a pane: %q", got)
	}
}
