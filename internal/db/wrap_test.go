package db

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
)

func TestScan(t *testing.T) {
	pg, my := config.DBPostgres, config.DBMySQL
	for _, c := range []struct {
		kind, sql string
		want      stmt
	}{
		{pg, "SELECT 1", stmt{body: "SELECT 1", first: "select"}},
		{pg, "  select 1 ;  ", stmt{body: "  select 1", first: "select"}},
		{pg, "SELECT 1;;\n-- the end", stmt{body: "SELECT 1", first: "select"}},
		{pg, "-- a note\n/* and /* a nested */ one */ Select 1", stmt{body: "-- a note\n/* and /* a nested */ one */ Select 1", first: "select"}},
		{pg, "((SELECT 1) UNION (SELECT 2))", stmt{body: "((SELECT 1) UNION (SELECT 2))", first: "select"}},
		{pg, "SELECT 1; SELECT 2", stmt{body: "SELECT 1; SELECT 2", first: "select", multi: true}},
		// A ; inside a string, a quoted name, a comment or a dollar quote ends nothing.
		{pg, `SELECT ';', ";" /* ; */ -- ;`, stmt{body: `SELECT ';', ";"`, first: "select"}},
		{pg, "SELECT $$;$$, $x$ ; $$ $x$, 'it''s;'", stmt{body: "SELECT $$;$$, $x$ ; $$ $x$, 'it''s;'", first: "select"}},
		{pg, `SELECT E'\';', 1`, stmt{body: `SELECT E'\';', 1`, first: "select"}},
		{pg, "SELECT $1", stmt{body: "SELECT $1", first: "select"}},
		{my, `SELECT '\';', "\";", ` + "`;`" + ` # ;`, stmt{body: `SELECT '\';', "\";", ` + "`;`", first: "select"}},
		// In MySQL `--` needs white space after it, and /* */ does not nest.
		{my, "SELECT 1--1", stmt{body: "SELECT 1--1", first: "select"}},
		{my, "SELECT 1 /* a /* b */ ;", stmt{body: "SELECT 1", first: "select"}},
		// MySQL runs what is inside /*! */: it stays in the statement.
		{my, "SELECT a FROM t /*!50700 WHERE a > 0 */ ;", stmt{body: "SELECT a FROM t /*!50700 WHERE a > 0 */", first: "select"}},
		{pg, "SELECT a FROM t /*! WHERE a > 0 */", stmt{body: "SELECT a FROM t", first: "select"}},
		// In PostgreSQL # is an operator.
		{pg, "SELECT 5 # 3", stmt{body: "SELECT 5 # 3", first: "select"}},
		{pg, "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", stmt{body: "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", first: "with", modifying: true}},
		{pg, "WITH d AS MATERIALIZED (SELECT * FROM t FOR UPDATE) SELECT * FROM d", stmt{body: "WITH d AS MATERIALIZED (SELECT * FROM t FOR UPDATE) SELECT * FROM d", first: "with"}},
		{pg, `"select"`, stmt{body: `"select"`}},
		{pg, "SHOW search_path", stmt{body: "SHOW search_path", first: "show"}},
		{pg, "", stmt{}},
	} {
		if got := scan(c.kind, c.sql); got != c.want {
			t.Errorf("%s %q:\n got %+v\nwant %+v", c.kind, c.sql, got, c.want)
		}
	}
}

func TestWrappable(t *testing.T) {
	pg, my := config.DBPostgres, config.DBMySQL
	cols := func(names ...string) []Column {
		var out []Column
		for _, n := range names {
			out = append(out, Column{Name: n})
		}
		return out
	}
	for _, c := range []struct {
		kind, sql string
		cols      []Column
		want      bool
	}{
		{pg, "SELECT * FROM t", cols("a"), true},
		{my, "/* x */ (SELECT * FROM t);", cols("a"), true},
		{pg, "WITH x AS (SELECT 1 AS a) SELECT * FROM x", cols("a"), true},
		{pg, "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", cols("a"), false},
		{pg, "SHOW search_path", cols("search_path"), false},
		{my, "EXPLAIN SELECT 1", cols("id"), false},
		{pg, "DELETE FROM t RETURNING *", cols("a"), false},
		{pg, "INSERT INTO t SELECT 1", nil, false},
		// A SELECT that gives no columns (SELECT ... INTO).
		{pg, "SELECT * INTO u FROM t", nil, false},
		{pg, "SELECT 1; SELECT 2", cols("a"), false},
		// MySQL refuses two columns of one name in a derived table; PostgreSQL does not.
		{my, "SELECT * FROM a JOIN b USING (x)", cols("id", "ID"), false},
		{pg, "SELECT * FROM a, b", cols("id", "id"), true},
	} {
		if got := wrappable(c.kind, c.sql, c.cols); got != c.want {
			t.Errorf("%s %q %v: got %v", c.kind, c.sql, c.cols, got)
		}
	}
}

func TestWrapSQL(t *testing.T) {
	got, err := wrapSQL(config.DBPostgres, "SELECT 1 -- one;\n;", 1000, 1001)
	want := "SELECT * FROM (\nSELECT 1\n) AS q LIMIT 1001 OFFSET 1000"
	if err != nil || got != want {
		t.Errorf("got %q, %v", got, err)
	}
	// A comment at the end of the last line does not swallow the parenthesis.
	got, _ = wrapSQL(config.DBMySQL, "SELECT 1 -- one", 5, 6)
	if !strings.HasPrefix(got, "SELECT * FROM (\nSELECT 1\n)") {
		t.Errorf("got %q", got)
	}
	if _, err := wrapSQL(config.DBMySQL, "SHOW TABLES", 5, 6); err == nil {
		t.Error("SHOW was wrapped")
	}
}

// The pages of a SELECT, read with Offset on a real database, follow one
// another; a statement that cannot be wrapped is refused before it is sent.
func TestPages(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		for _, readOnly := range []bool{false, true} {
			c.ReadOnly = readOnly
			s := open(t, c)
			sql := "-- the numbers\n" + numbers(c, 25) + " ORDER BY g; -- done"
			var got []string
			offset := 0
			for page := 0; ; page++ {
				res, err := s.Query(context.Background(), sql, QueryOptions{MaxRows: 10, Offset: offset})
				if err != nil {
					t.Fatalf("read-only %v, page %d: %v", readOnly, page, err)
				}
				if !res.Wrappable || res.Offset != offset {
					t.Fatalf("read-only %v, page %d: %+v", readOnly, page, res)
				}
				for _, row := range res.Rows {
					got = append(got, *row[0])
				}
				offset += res.RowCount
				if !res.Truncated {
					break
				}
				if page > 3 {
					t.Fatal("too many pages")
				}
			}
			if len(got) != 25 || got[0] != "1" || got[10] != "11" || got[24] != "25" {
				t.Errorf("read-only %v: %v", readOnly, got)
			}
		}

		s := open(t, c)
		// A page after the last has no rows.
		res, err := s.Query(context.Background(), numbers(c, 3), QueryOptions{Offset: 5})
		if err != nil || res.RowCount != 0 || res.Truncated || len(res.Columns) != 1 {
			t.Errorf("after the last: %+v, %v", res, err)
		}
		show := "SHOW TIME ZONE"
		if c.Kind == config.DBMySQL {
			show = "SHOW TABLES"
		}
		if res := query(t, s, show); res.Wrappable {
			t.Errorf("SHOW is wrappable: %+v", res)
		}
		if _, err := s.Query(context.Background(), show, QueryOptions{Offset: 5}); err == nil {
			t.Errorf("SHOW was paged")
		} else if e, ok := err.(*Error); !ok || e.Kind != KindQuery {
			t.Errorf("SHOW: %v", err)
		}
		if res := query(t, s, "SELECT 1 AS a, 2 AS b"); !res.Wrappable {
			t.Errorf("SELECT is not wrappable: %+v", res)
		}
		// Two columns of one name: PostgreSQL wraps it, MySQL would refuse.
		dup := query(t, s, "SELECT 1 AS a, 2 AS a")
		if dup.Wrappable != (c.Kind == config.DBPostgres) {
			t.Errorf("two columns named a: wrappable %v", dup.Wrappable)
		}
		if dup.Wrappable {
			res, err := s.Query(context.Background(), "SELECT 1 AS a, 2 AS a UNION ALL SELECT 3, 4", QueryOptions{Offset: 1})
			if err != nil || fmt.Sprint(cells(res)) != "[[3 4]]" {
				t.Errorf("two columns named a, wrapped: %+v, %v", res, err)
			}
		}
	})
}
