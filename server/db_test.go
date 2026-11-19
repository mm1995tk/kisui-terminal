package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// dbServer は、conns を設定に書いたことにした serve と、hello を済ませた接続。
// キーチェーンとパスワードのファイルは空で、pw で差し替えられる。
func dbServer(t *testing.T, pw *db.Passwords, conns ...config.DBConnection) *rpc.Conn {
	t.Helper()
	if pw == nil {
		pw = &db.Passwords{}
	}
	if pw.Keychain == nil {
		pw.Keychain = func(context.Context, config.DBConnection) (string, bool) { return "", false }
	}
	if pw.File == nil {
		pw.File = func(config.DBConnection) (string, bool) { return "", false }
	}
	_, sock := startWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return conns, nil }
		o.DBPasswords = pw
	})
	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	return c
}

// dbResult は db.query の結果を、窓が読む形（JSON）のまま受けたもの。
type dbResult struct {
	Columns []struct {
		Name string `json:"name"`
		Type string `json:"type"`
		Kind string `json:"kind"`
	} `json:"columns"`
	Rows         [][]*string `json:"rows"`
	RowCount     int         `json:"rowCount"`
	Truncated    bool        `json:"truncated"`
	RowsAffected *int64      `json:"rowsAffected"`
	ElapsedMs    *float64    `json:"elapsedMs"`
}

// dbErr は err を db.* のエラーとして読む。data は中身を map にしたもの。
func dbErr(t *testing.T, err error) (code int, data map[string]any) {
	t.Helper()
	e, ok := err.(*rpc.Error)
	if !ok {
		t.Fatalf("not an rpc error: %v", err)
	}
	if len(e.Data) > 0 {
		if err := json.Unmarshal(e.Data, &data); err != nil {
			t.Fatal(err)
		}
	}
	return e.Code, data
}

// bothDB は PostgreSQL と MySQL の両方でテストを回す。
func bothDB(t *testing.T, f func(t *testing.T, c config.DBConnection)) {
	t.Run("postgres", func(t *testing.T) { f(t, dbtest.Postgres(t)) })
	t.Run("mysql", func(t *testing.T) { f(t, dbtest.MySQL(t)) })
}

func TestDBCapability(t *testing.T) {
	_, sock := start(t)
	c := dial(t, sock)
	// hello より前は断る。
	err := c.Call(context.Background(), "db.connections", struct{}{}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeInvalidRequest {
		t.Errorf("db.connections before hello: %v", err)
	}
	var h HelloResult
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), &h); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(h.Capabilities, CapDB) {
		t.Errorf("capabilities: %v", h.Capabilities)
	}
	err = c.Call(context.Background(), "db.nosuch", struct{}{}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeMethodNotFound {
		t.Errorf("db.nosuch: %v", err)
	}
}

// 接続の一覧は設定に書いたものだけで、パスワードはどこから見つかったものも入らない。
func TestDBConnections(t *testing.T) {
	conn := config.DBConnection{Name: "prod", Kind: config.DBMySQL, Host: "db.example.com", Port: 3307, User: "reader", Database: "shop", ReadOnly: true}
	pw := &db.Passwords{
		Keychain: func(context.Context, config.DBConnection) (string, bool) { return "keychain-secret", true },
		File:     func(config.DBConnection) (string, bool) { return "file-secret", true },
	}
	pw.Remember(conn, "typed-secret")
	c := dbServer(t, pw, conn)
	var raw json.RawMessage
	if err := c.Call(context.Background(), "db.connections", struct{}{}, &raw); err != nil {
		t.Fatal(err)
	}
	want := `{"connections":[{"name":"prod","kind":"mysql","host":"db.example.com","port":3307,"user":"reader","database":"shop","readOnly":true}],"problems":[]}`
	if string(raw) != want {
		t.Errorf("got  %s\nwant %s", raw, want)
	}
	if strings.Contains(string(raw), "secret") || strings.Contains(strings.ToLower(string(raw)), "password") {
		t.Errorf("the list has a password: %s", raw)
	}
}

// config.toml に書いた接続が一覧に出て、SQL を実行できる。書き直すと、serve を起動し直さなくても変わる。
// 間違いのある接続は一覧から外れ、間違いとして返る。
func TestDBFromConfigFile(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		dir := filepath.Join(t.TempDir(), "kisui-terminal")
		t.Setenv("XDG_CONFIG_HOME", filepath.Dir(dir))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		// パスワードは ~/.pgpass・~/.my.cnf から（キーチェーンは、macOS でもこの名前のものは無い）。
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("PGPASSFILE", "")
		os.WriteFile(filepath.Join(home, ".pgpass"), []byte("*:*:*:"+dbtest.User+":"+dbtest.Password+"\n"), 0o600)
		os.WriteFile(filepath.Join(home, ".my.cnf"), []byte("[client]\npassword = \""+dbtest.Password+"\"\n"), 0o600)
		entry := func(name string) string {
			return "[[db.connections]]\nname = \"" + name + "\"\nkind = \"" + conn.Kind + "\"\nhost = \"" + conn.Host + "\"\nport = " + strconv.Itoa(conn.Port) +
				"\nuser = \"" + conn.User + "\"\ndatabase = \"" + conn.Database + "\"\n"
		}
		write := func(text string) {
			if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		write(entry("kisui-test-from-file"))

		_, sock := start(t)
		c := dial(t, sock)
		ctx := context.Background()
		if err := c.Call(ctx, "session.hello", hello(Protocol.Major), nil); err != nil {
			t.Fatal(err)
		}
		var list DBConnectionsResult
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Connections) != 1 || list.Connections[0].Name != "kisui-test-from-file" || list.Connections[0].Kind != conn.Kind || len(list.Problems) != 0 {
			t.Fatalf("connections: %+v", list)
		}
		var res dbResult
		if err := c.Call(ctx, "db.query", map[string]any{"connection": "kisui-test-from-file", "sql": "SELECT 40 + 2 AS answer"}, &res); err != nil {
			t.Fatal(err)
		}
		if len(res.Columns) != 1 || res.Columns[0].Name != "answer" || res.Columns[0].Kind != "number" || res.Columns[0].Type == "" ||
			res.RowCount != 1 || len(res.Rows) != 1 || *res.Rows[0][0] != "42" || res.Truncated || res.ElapsedMs == nil {
			t.Errorf("result: %+v", res)
		}

		write(entry("kisui-test-renamed") + "[[db.connections]]\nname = \"broken\"\nkind = \"sqlite\"\nuser = \"u\"\n")
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Connections) != 1 || list.Connections[0].Name != "kisui-test-renamed" || len(list.Problems) != 1 || !strings.Contains(list.Problems[0], "db.connections[1].kind") {
			t.Errorf("after a rewrite: %+v", list)
		}
		err := c.Call(ctx, "db.query", map[string]any{"connection": "kisui-test-from-file", "sql": "SELECT 1"}, nil)
		if code, _ := dbErr(t, err); code != rpc.CodeNotFound {
			t.Errorf("a connection that is gone: %v", err)
		}
	})
}

// パスワードがどこにも無ければ password_required。窓が渡したものが通れば覚え、次からは聞かない。
func TestDBPasswordFromWindow(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		c := dbServer(t, nil, conn)
		ctx := context.Background()
		query := func(extra map[string]any) error {
			p := map[string]any{"connection": conn.Name, "sql": "SELECT 1"}
			for k, v := range extra {
				p[k] = v
			}
			return c.Call(ctx, "db.query", p, nil)
		}
		if code, data := dbErr(t, query(nil)); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
			t.Errorf("no password: %d %v", code, data)
		}
		if code, data := dbErr(t, query(map[string]any{"password": "wrong"})); code != rpc.CodePasswordRequired || data["reason"] != "rejected" {
			t.Errorf("a wrong password: %d %v", code, data)
		}
		// 断られたものは覚えない。
		if code, data := dbErr(t, query(nil)); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
			t.Errorf("after a wrong password: %d %v", code, data)
		}
		if err := query(map[string]any{"password": dbtest.Password}); err != nil {
			t.Fatalf("the right password: %v", err)
		}
		if err := query(nil); err != nil {
			t.Errorf("the remembered password: %v", err)
		}
	})
}

// キーチェーン・ファイルのパスワードは、窓が渡したものより先に使う。それが断られたら、聞き直しても直らないので
// password_required ではなく db_error（kind は auth）で、見つけた場所を返す。
func TestDBPasswordFromMachine(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ctx := context.Background()
		for _, src := range []string{"keychain", "file"} {
			found := dbtest.Password
			find := func() (string, bool) { return found, true }
			pw := &db.Passwords{}
			if src == "keychain" {
				pw.Keychain = func(context.Context, config.DBConnection) (string, bool) { return find() }
			} else {
				pw.File = func(config.DBConnection) (string, bool) { return find() }
			}
			c := dbServer(t, pw, conn)
			// 窓が違うパスワードを渡しても、見つけたものでつながる。
			if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1", "password": "wrong"}, nil); err != nil {
				t.Errorf("%s: %v", src, err)
			}
			found = "wrong"
			err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1", "password": dbtest.Password}, nil)
			if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "auth" || data["passwordSource"] != src {
				t.Errorf("%s with a wrong password: %d %v", src, code, data)
			}
		}
	})
}

// read-only = true の接続では UPDATE が失敗し、書いていない接続では通る。
func TestDBReadOnly(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ro := conn
		ro.Name, ro.ReadOnly = "ro", true
		c := dbServer(t, nil, conn, ro)
		ctx := context.Background()
		query := func(name, sql string) (dbResult, error) {
			var res dbResult
			err := c.Call(ctx, "db.query", map[string]any{"connection": name, "sql": sql, "password": dbtest.Password}, &res)
			return res, err
		}
		table := "t_server_readonly"
		for _, sql := range []string{"DROP TABLE IF EXISTS " + table, "CREATE TABLE " + table + " (id INT)", "INSERT INTO " + table + " VALUES (1)"} {
			if _, err := query(conn.Name, sql); err != nil {
				t.Fatalf("%s: %v", sql, err)
			}
		}
		_, err := query("ro", "UPDATE "+table+" SET id = 2")
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" || data["sqlState"] != "25006" {
			t.Errorf("UPDATE on a read-only connection: %v", err)
		}
		res, err := query("ro", "SELECT id FROM "+table)
		if err != nil || len(res.Rows) != 1 || *res.Rows[0][0] != "1" {
			t.Errorf("SELECT on a read-only connection: %+v, %v", res, err)
		}
		res, err = query(conn.Name, "UPDATE "+table+" SET id = 2")
		if err != nil || res.RowsAffected == nil || *res.RowsAffected != 1 {
			t.Errorf("UPDATE: %+v, %v", res, err)
		}
		res, err = query(conn.Name, "SELECT id FROM "+table)
		if err != nil || !reflect.DeepEqual(*res.Rows[0][0], "2") {
			t.Errorf("after the UPDATE: %+v, %v", res, err)
		}
	})
}

func TestDBQueryParams(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		c := dbServer(t, nil, conn)
		ctx := context.Background()
		call := func(p map[string]any) (dbResult, error) {
			var res dbResult
			p["password"] = dbtest.Password
			err := c.Call(ctx, "db.query", p, &res)
			return res, err
		}
		if _, err := call(map[string]any{"connection": "nosuch", "sql": "SELECT 1"}); err.(*rpc.Error).Code != rpc.CodeNotFound {
			t.Errorf("an unknown connection: %v", err)
		}
		if _, err := call(map[string]any{"connection": conn.Name, "sql": "  "}); err.(*rpc.Error).Code != rpc.CodeInvalidParams {
			t.Errorf("an empty sql: %v", err)
		}
		_, err := call(map[string]any{"connection": conn.Name, "sql": "SELEC 1"})
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" || data["sqlState"] == nil {
			t.Errorf("a syntax error: %v", err)
		}
		// maxRows で行数を絞れる。NULL は null で届く。
		res, err := call(map[string]any{"connection": conn.Name, "sql": "SELECT NULL AS n UNION ALL SELECT NULL UNION ALL SELECT NULL", "maxRows": 2})
		if err != nil || res.RowCount != 2 || !res.Truncated || res.Rows[0][0] != nil {
			t.Errorf("maxRows: %+v, %v", res, err)
		}
	})
}

// db.cancel は、動いている SQL を止める。db.query は db_error（kind は cancelled）で返る。
func TestDBCancel(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		c := dbServer(t, nil, conn)
		ctx := context.Background()
		// 取り消されたら行を書かずに終わる（MySQL の sleep() は止められても間違いにならないので、INSERT で確かめる）。
		setup := []string{"DROP TABLE IF EXISTS t_server_cancel", "CREATE TABLE t_server_cancel (id INT)"}
		slow := "INSERT INTO t_server_cancel SELECT 1 FROM pg_sleep(30)"
		if conn.Kind == config.DBMySQL {
			// 1 行だけだと、止められた sleep() が 1 を返して INSERT が通ってしまう。
			slow = "INSERT INTO t_server_cancel SELECT sleep(30) FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3) AS x"
		}
		for _, sql := range setup {
			if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": sql, "password": dbtest.Password}, nil); err != nil {
				t.Fatal(err)
			}
		}
		done := make(chan error, 1)
		start := time.Now()
		go func() {
			done <- c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": slow, "queryId": "q1"}, nil)
		}()
		// 動き始めるまで、db.cancel は not_found。
		deadline := time.Now().Add(10 * time.Second)
		for {
			err := c.Call(ctx, "db.cancel", map[string]any{"queryId": "q1"}, nil)
			if err == nil {
				break
			}
			if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeNotFound || time.Now().After(deadline) {
				t.Fatalf("db.cancel: %v", err)
			}
			time.Sleep(20 * time.Millisecond)
		}
		err := <-done
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "cancelled" {
			t.Errorf("the cancelled statement: %v", err)
		}
		if d := time.Since(start); d > 10*time.Second {
			t.Errorf("it took %v", d)
		}
		if err := c.Call(ctx, "db.cancel", map[string]any{"queryId": "q1"}, nil); err.(*rpc.Error).Code != rpc.CodeNotFound {
			t.Errorf("db.cancel after the end: %v", err)
		}
		var res dbResult
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT count(*) FROM t_server_cancel"}, &res); err != nil || *res.Rows[0][0] != "0" {
			t.Errorf("rows after a cancelled INSERT: %+v, %v", res, err)
		}
	})
}

// SQL が動いている間も、ほかの要求（と serve の引き継ぎが待つ書きロック）は止まらない。
func TestDBQueryDoesNotHoldTheLock(t *testing.T) {
	conn := dbtest.Postgres(t)
	pw := &db.Passwords{File: func(config.DBConnection) (string, bool) { return dbtest.Password, true }}
	pw.Keychain = func(context.Context, config.DBConnection) (string, bool) { return "", false }
	srv, sock := startWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return []config.DBConnection{conn}, nil }
		o.DBPasswords = pw
	})
	c := dial(t, sock)
	ctx := context.Background()
	if err := c.Call(ctx, "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT pg_sleep(30)", "queryId": "slow"}, nil)
	}()
	for {
		srv.db.mu.Lock()
		n := len(srv.db.running)
		srv.db.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	locked := make(chan struct{})
	go func() {
		srv.opMu.Lock()
		srv.opMu.Unlock() //nolint:staticcheck // 取れることだけを確かめる
		close(locked)
	}()
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("the write lock waits for the statement")
	}
	if err := c.Call(ctx, "db.cancel", map[string]any{"queryId": "slow"}, nil); err != nil {
		t.Fatal(err)
	}
	<-done
}
