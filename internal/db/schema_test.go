package db

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
)

// TestSchema: a statement with QueryOptions.Schema finds the tables it names
// without a schema in that schema, and the next statement without it does
// not (#378).
func TestSchema(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		// A name that must be quoted: a space, a quote of the database's own
		// kind, and upper case.
		other, home := `Sch "x" `+"`y`", "kisui"
		admin := c
		if c.Kind == config.DBPostgres {
			home = "public"
		} else {
			// MySQL's user of the tests may only use the database "kisui";
			// root (with no password) makes the other database and lets it in.
			admin.User = "root"
		}
		s, err := Open(context.Background(), admin, adminPassword(c))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		q := func(sql string) { t.Helper(); query(t, s, sql) }
		quote := pgQuoteIdent
		if c.Kind == config.DBMySQL {
			quote = myQuoteIdent
		}
		if c.Kind == config.DBPostgres {
			q("DROP SCHEMA IF EXISTS " + quote(other) + " CASCADE")
			q("CREATE SCHEMA " + quote(other))
		} else {
			q("DROP DATABASE IF EXISTS " + quote(other))
			q("CREATE DATABASE " + quote(other))
			q("GRANT ALL ON " + quote(other) + ".* TO '" + dbtest.User + "'@'localhost'")
		}
		for _, sch := range []string{home, other} {
			q("DROP TABLE IF EXISTS " + quote(sch) + ".sch_t")
			q("CREATE TABLE " + quote(sch) + ".sch_t (v VARCHAR(40))")
			q("INSERT INTO " + quote(sch) + ".sch_t VALUES ('" + strings.ReplaceAll(sch, "'", "''") + "')")
		}

		for _, ro := range []bool{false, true} {
			c := c
			c.ReadOnly = ro
			// A login of its own for each statement, as kisui serve does.
			run := func(o QueryOptions) [][]string {
				t.Helper()
				res, err := open(t, c).Query(context.Background(), "SELECT v FROM sch_t", o)
				if err != nil {
					t.Fatalf("read-only %v, schema %q: %v", ro, o.Schema, err)
				}
				return cells(res)
			}
			if got := run(QueryOptions{Schema: other}); !reflect.DeepEqual(got, [][]string{{other}}) {
				t.Errorf("read-only %v, with the schema: %v", ro, got)
			}
			// With no schema, it is the default of the database.
			if got := run(QueryOptions{}); !reflect.DeepEqual(got, [][]string{{home}}) {
				t.Errorf("read-only %v, without the schema: %v", ro, got)
			}
			// A wrapped statement (a sorting, a page) reads the same schema.
			if got := run(QueryOptions{Schema: other, OrderBy: 1}); !reflect.DeepEqual(got, [][]string{{other}}) {
				t.Errorf("read-only %v, sorted: %v", ro, got)
			}
		}

		if c.Kind == config.DBPostgres {
			// The search_path of the login stays after the schema, so that
			// what is found through it is still found.
			s := open(t, c)
			res, err := s.Query(context.Background(), "SHOW search_path", QueryOptions{Schema: other})
			if err != nil {
				t.Fatal(err)
			}
			if got := cells(res); len(got) != 1 || got[0][0] != pgQuoteIdent(other)+`, "$user", public` {
				t.Errorf("search_path: %v", got)
			}
		}
	})
}

// TestSchemaMissing: a schema that is not there is not an error of its own in
// PostgreSQL (the search_path may name one), and the database refuses it in
// MySQL (USE).
func TestSchemaMissing(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		s := open(t, c)
		_, err := s.Query(context.Background(), "SELECT 1", QueryOptions{Schema: "no_such_schema_here"})
		if c.Kind == config.DBPostgres {
			if err != nil {
				t.Errorf("postgres: %v", err)
			}
			return
		}
		e, ok := errors.AsType[*Error](err)
		if !ok || e.Kind != KindQuery || !strings.Contains(e.Message, "no_such_schema_here") {
			t.Errorf("mysql: %v (%+v)", err, e)
		}
		// The session still works.
		if got := cells(query(t, s, "SELECT 1")); !reflect.DeepEqual(got, [][]string{{"1"}}) {
			t.Errorf("after an error: %v", got)
		}
	})
}

// adminPassword is the password of the login that prepares TestSchema:
// the user of the tests in PostgreSQL, root (none) in MySQL.
func adminPassword(c config.DBLogin) string {
	if c.Kind == config.DBMySQL {
		return ""
	}
	return dbtest.Password
}
