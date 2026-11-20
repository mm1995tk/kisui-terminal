package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
)

func TestMain(m *testing.M) {
	code := m.Run()
	dbtest.Stop()
	os.Exit(code)
}

// both runs a test on PostgreSQL and on MySQL.
func both(t *testing.T, f func(t *testing.T, c config.DBConnection)) {
	t.Run("postgres", func(t *testing.T) { f(t, dbtest.Postgres(t)) })
	t.Run("mysql", func(t *testing.T) { f(t, dbtest.MySQL(t)) })
}

func open(t *testing.T, c config.DBConnection) Session {
	t.Helper()
	s, err := Open(context.Background(), c, dbtest.Password)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func query(t *testing.T, s Session, sql string) *Result {
	t.Helper()
	res, err := s.Query(context.Background(), sql, QueryOptions{})
	if err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return res
}

// cells is the rows with NULL written as "<null>".
func cells(res *Result) [][]string {
	out := make([][]string, len(res.Rows))
	for i, row := range res.Rows {
		for _, c := range row {
			if c == nil {
				out[i] = append(out[i], "<null>")
			} else {
				out[i] = append(out[i], *c)
			}
		}
	}
	return out
}

// table makes an empty table of its own for a test and returns its name.
func table(t *testing.T, c config.DBConnection, columns string) string {
	t.Helper()
	name := "t_" + strings.ToLower(strings.NewReplacer("/", "_", "-", "_").Replace(t.Name()))
	s := open(t, c)
	query(t, s, "DROP TABLE IF EXISTS "+name)
	query(t, s, "CREATE TABLE "+name+" ("+columns+")")
	return name
}

func TestSelect(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		s := open(t, c)
		res := query(t, s, "SELECT 1 AS one, 'héllo' AS word, NULL AS nothing, 12345678901234567890.5 AS big")
		var names []string
		for _, col := range res.Columns {
			names = append(names, col.Name)
		}
		if !reflect.DeepEqual(names, []string{"one", "word", "nothing", "big"}) {
			t.Errorf("columns: %+v", res.Columns)
		}
		// A number wider than a float64 keeps every digit.
		if got := cells(res); !reflect.DeepEqual(got, [][]string{{"1", "héllo", "<null>", "12345678901234567890.5"}}) {
			t.Errorf("rows: %v", got)
		}
		if res.RowCount != 1 || res.Truncated || res.RowsAffected != nil || res.ElapsedMs <= 0 {
			t.Errorf("result: %+v", res)
		}
		if res.Columns[0].Kind != KindNumber || res.Columns[1].Kind != KindText || res.Columns[3].Kind != KindNumber {
			t.Errorf("kinds: %+v", res.Columns)
		}
	})
}

func TestTypes(t *testing.T) {
	t.Run("postgres", func(t *testing.T) {
		s := open(t, dbtest.Postgres(t))
		res := query(t, s, `SELECT true AS b, 'a'::varchar(20) AS v, 9223372036854775807::bigint AS i8,
			'\xdead'::bytea AS raw, ARRAY['x','y'] AS arr, DATE '2024-02-29' AS d, '{"k": 1}'::jsonb AS j, 1.50::numeric(6,2) AS n`)
		want := []Column{
			{"b", "boolean", KindBoolean}, {"v", "character varying(20)", KindText}, {"i8", "bigint", KindNumber},
			{"raw", "bytea", KindBinary}, {"arr", "text[]", KindText}, {"d", "date", KindText}, {"j", "jsonb", KindText},
			{"n", "numeric(6,2)", KindNumber},
		}
		if !reflect.DeepEqual(res.Columns, want) {
			t.Errorf("columns: %+v", res.Columns)
		}
		if got := cells(res); !reflect.DeepEqual(got, [][]string{{"true", "a", "9223372036854775807", "0xdead", "{x,y}", "2024-02-29", `{"k": 1}`, "1.50"}}) {
			t.Errorf("rows: %v", got)
		}
	})
	t.Run("mysql", func(t *testing.T) {
		c := dbtest.MySQL(t)
		name := table(t, c, "i INT UNSIGNED, v VARCHAR(20), b VARBINARY(4), d DATETIME, j JSON, n DECIMAL(6,2), u BIGINT UNSIGNED, f FLOAT")
		s := open(t, c)
		query(t, s, "INSERT INTO "+name+` VALUES (7, 'a', x'DEAD', '2024-02-29 01:02:03', '{"k": 1}', 1.50, 18446744073709551615, 0.1)`)
		res := query(t, s, "SELECT * FROM "+name)
		want := []Column{
			{"i", "int unsigned", KindNumber}, {"v", "varchar", KindText}, {"b", "varbinary", KindBinary},
			{"d", "datetime", KindText}, {"j", "json", KindText}, {"n", "decimal", KindNumber},
			{"u", "bigint unsigned", KindNumber}, {"f", "float", KindNumber},
		}
		if !reflect.DeepEqual(res.Columns, want) {
			t.Errorf("columns: %+v", res.Columns)
		}
		if got := cells(res); !reflect.DeepEqual(got, [][]string{{"7", "a", "0xdead", "2024-02-29 01:02:03", `{"k": 1}`, "1.50", "18446744073709551615", "0.1"}}) {
			t.Errorf("rows: %v", got)
		}
	})
}

func TestWrite(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		name := table(t, c, "id INT, word VARCHAR(10)")
		s := open(t, c)
		res := query(t, s, "INSERT INTO "+name+" VALUES (1, 'a'), (2, 'b'), (3, 'c')")
		if res.RowsAffected == nil || *res.RowsAffected != 3 || len(res.Columns) != 0 || res.RowCount != 0 {
			t.Errorf("insert: %+v", res)
		}
		res = query(t, s, "UPDATE "+name+" SET word = 'z' WHERE id > 1")
		if res.RowsAffected == nil || *res.RowsAffected != 2 {
			t.Errorf("update: %+v", res)
		}
		// Each statement is committed by itself: another session sees it.
		if got := cells(query(t, open(t, c), "SELECT word FROM "+name+" ORDER BY id")); !reflect.DeepEqual(got, [][]string{{"a"}, {"z"}, {"z"}}) {
			t.Errorf("rows: %v", got)
		}
	})
}

// A read-only connection refuses a write, and the database is the one that
// refuses it.
func TestReadOnly(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		name := table(t, c, "id INT")
		query(t, open(t, c), "INSERT INTO "+name+" VALUES (1)")
		ro := c
		ro.ReadOnly = true
		s := open(t, ro)
		for _, sql := range []string{
			"UPDATE " + name + " SET id = 2",
			"INSERT INTO " + name + " VALUES (5)",
			"DELETE FROM " + name,
			"DROP TABLE " + name,
		} {
			_, err := s.Query(context.Background(), sql, QueryOptions{})
			e, ok := errors.AsType[*Error](err)
			if !ok || e.Kind != KindQuery || e.SQLState != "25006" {
				t.Errorf("%s: %v (%+v)", sql, err, e)
			}
		}
		// Reading works, more than once on the same session, and nothing
		// changed.
		for range 2 {
			if got := cells(query(t, s, "SELECT id FROM "+name)); !reflect.DeepEqual(got, [][]string{{"1"}}) {
				t.Errorf("rows: %v", got)
			}
		}
	})
}

func TestQueryError(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		s := open(t, c)
		_, err := s.Query(context.Background(), "SELECT * FROM no_such_table_here", QueryOptions{})
		e, ok := errors.AsType[*Error](err)
		if !ok || e.Kind != KindQuery || e.SQLState == "" || !strings.Contains(e.Message, "no_such_table_here") {
			t.Fatalf("%v (%+v)", err, e)
		}
		// One request is one statement.
		if _, err := s.Query(context.Background(), "SELECT 1; SELECT 2", QueryOptions{}); err == nil {
			t.Error("two statements in one request were run")
		}
		// The session still works after an error.
		if got := cells(query(t, s, "SELECT 1")); !reflect.DeepEqual(got, [][]string{{"1"}}) {
			t.Errorf("after an error: %v", got)
		}
	})
}

// numbers is a SELECT that gives n rows.
func numbers(c config.DBConnection, n int) string {
	if c.Kind == config.DBPostgres {
		return fmt.Sprintf("SELECT g FROM generate_series(1, %d) AS g", n)
	}
	return fmt.Sprintf("WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM s WHERE g < %d) SELECT /*+ SET_VAR(cte_max_recursion_depth = 100000000) */ g FROM s", n)
}

func TestRowLimit(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		for _, readOnly := range []bool{false, true} {
			c.ReadOnly = readOnly
			s := open(t, c)
			res, err := s.Query(context.Background(), numbers(c, 50), QueryOptions{MaxRows: 20})
			if err != nil {
				t.Fatal(err)
			}
			if res.RowCount != 20 || len(res.Rows) != 20 || !res.Truncated || *res.Rows[19][0] != "20" {
				t.Errorf("read-only %v: %d rows, truncated %v", readOnly, res.RowCount, res.Truncated)
			}
			res, err = s.Query(context.Background(), numbers(c, 20), QueryOptions{MaxRows: 20})
			if err != nil || res.RowCount != 20 || res.Truncated {
				t.Errorf("read-only %v: exactly the limit: %+v, %v", readOnly, res, err)
			}
			// The default, and the session works after a truncated result.
			res, err = s.Query(context.Background(), numbers(c, DefaultMaxRows+1), QueryOptions{})
			if err != nil || res.RowCount != DefaultMaxRows || !res.Truncated {
				t.Errorf("read-only %v: the default limit: %v", readOnly, err)
			}
		}
	})
}

// endless is a SELECT that gives its first rows at once and far more rows
// than anyone reads.
func endless(t *testing.T, c config.DBConnection) string {
	if c.Kind == config.DBPostgres {
		// In FROM, generate_series is built as a whole before its first row.
		return "SELECT generate_series(1, 2000000000) AS g"
	}
	// MySQL builds a recursive CTE as a whole before its first row, so the
	// rows come from joining a small table with itself.
	name := table(t, c, "g INT")
	query(t, open(t, c), "INSERT INTO "+name+" "+numbers(c, 1000))
	return "SELECT a.g FROM " + name + " a, " + name + " b, " + name + " c"
}

// A read-only session does not read a huge result to its end: it stops the
// statement when the result is full.
func TestRowLimitStopsReadOnly(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		sql := endless(t, c)
		c.ReadOnly = true
		s := open(t, c)
		start := time.Now()
		res, err := s.Query(context.Background(), sql, QueryOptions{MaxRows: 5})
		if err != nil || res.RowCount != 5 || !res.Truncated {
			t.Fatalf("%+v, %v", res, err)
		}
		if d := time.Since(start); d > 4*time.Second {
			t.Errorf("it took %v: the rest of the result was read", d)
		}
		if res.Columns[0].Kind != KindNumber || res.Columns[0].Type == "" {
			t.Errorf("columns: %+v", res.Columns)
		}
		if got := cells(query(t, s, "SELECT 1")); !reflect.DeepEqual(got, [][]string{{"1"}}) {
			t.Errorf("after a stop: %v", got)
		}
	})
}

// A long cell is cut, and the result says so.
func TestCellLimit(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		s := open(t, c)
		res := query(t, s, fmt.Sprintf("SELECT repeat('é', %d) AS long_one, 'short' AS short_one", maxCellBytes))
		if !res.TruncatedCells || len(*res.Rows[0][0]) != maxCellBytes || *res.Rows[0][1] != "short" {
			t.Errorf("truncatedCells %v, %d bytes", res.TruncatedCells, len(*res.Rows[0][0]))
		}
		if res := query(t, s, "SELECT 'short'"); res.TruncatedCells {
			t.Error("a short cell was reported as cut")
		}
	})
}

// Ending the context stops the statement in the database, soon.
func TestCancel(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		s := open(t, c)
		sleep := "SELECT pg_sleep(30)"
		if c.Kind == config.DBMySQL {
			sleep = "SELECT sleep(30)"
		}
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(300*time.Millisecond, cancel)
		start := time.Now()
		res, err := s.Query(ctx, sleep, QueryOptions{})
		if c.Kind == config.DBMySQL && err == nil {
			// MySQL's sleep() does not fail when it is stopped: it returns 1.
			if got := cells(res); !reflect.DeepEqual(got, [][]string{{"1"}}) {
				t.Errorf("rows: %v", got)
			}
		} else if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindCancelled {
			t.Errorf("%v", err)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("it took %v", d)
		}
		// The session was not closed to stop it.
		if got := cells(query(t, s, "SELECT 1")); !reflect.DeepEqual(got, [][]string{{"1"}}) {
			t.Errorf("after a cancel: %v", got)
		}
	})
}

// A write that is cancelled is undone as a whole.
func TestCancelWrite(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		name := table(t, c, "id INT")
		s := open(t, c)
		slow := "INSERT INTO " + name + " SELECT g FROM generate_series(1, 3) AS g, pg_sleep(10)"
		if c.Kind == config.DBMySQL {
			slow = "INSERT INTO " + name + " SELECT 1 + sleep(10) FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3) AS x"
		}
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(300*time.Millisecond, cancel)
		_, err := s.Query(ctx, slow, QueryOptions{})
		if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindCancelled {
			t.Errorf("%v", err)
		}
		if got := cells(query(t, open(t, c), "SELECT count(*) FROM "+name)); !reflect.DeepEqual(got, [][]string{{"0"}}) {
			t.Errorf("rows after a cancelled insert: %v", got)
		}
	})
}

func TestOpenErrors(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		_, err := Open(context.Background(), c, "wrong")
		if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindAuth {
			t.Errorf("a wrong password: %v (%+v)", err, e)
		}
		_, err = Open(context.Background(), c, "")
		if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindAuth {
			t.Errorf("no password: %v (%+v)", err, e)
		}
		gone := c
		gone.Host = "/tmp/kisui-db-no-such-socket"
		_, err = Open(context.Background(), gone, dbtest.Password)
		if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindConnect {
			t.Errorf("no server: %v (%+v)", err, e)
		}
	})
}

// What one session leaves behind does not reach the next: each Open is a
// login of its own.
func TestSessionsAreApart(t *testing.T) {
	both(t, func(t *testing.T, c config.DBConnection) {
		a := open(t, c)
		set, show := "SET application_name = 'mine'", "SHOW application_name"
		if c.Kind == config.DBMySQL {
			set, show = "SET @mine = 'mine'", "SELECT @mine"
		}
		query(t, a, set)
		if got := cells(query(t, a, show)); got[0][0] != "mine" {
			t.Errorf("the same session: %v", got)
		}
		if got := cells(query(t, open(t, c), show)); got[0][0] == "mine" {
			t.Errorf("another session: %v", got)
		}
	})
}

// COPY is refused before it reaches the server: `COPY ... FROM STDIN` would
// wait for ever for data.
func TestCopyIsRefused(t *testing.T) {
	c := dbtest.Postgres(t)
	name := table(t, c, "id INT")
	s := open(t, c)
	for _, sql := range []string{
		"COPY " + name + " FROM STDIN",
		"  copy " + name + " TO STDOUT",
		"-- load\n/* a /* nested */ comment */ Copy " + name + " FROM STDIN",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, err := s.Query(ctx, sql, QueryOptions{})
		cancel()
		if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindQuery || !strings.Contains(e.Message, "COPY") {
			t.Errorf("%q: %v", sql, err)
		}
	}
	// A statement that only looks like one is run.
	if got := cells(query(t, s, "SELECT 'copy' AS copy /* COPY */")); !reflect.DeepEqual(got, [][]string{{"copy"}}) {
		t.Errorf("rows: %v", got)
	}
	for sql, want := range map[string]string{"": "", "  select 1": "select", "--x": "", "/* open": "", "copy_table": "copy_table"} {
		if got := firstWord(sql); got != want {
			t.Errorf("firstWord(%q) = %q, want %q", sql, got, want)
		}
	}
}
