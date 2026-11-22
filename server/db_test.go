package server

import (
	"context"
	"encoding/json"
	"maps"
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
		pw.Keychain = func(context.Context, config.DBLogin) (string, bool) { return "", false }
	}
	if pw.File == nil {
		pw.File = func(config.DBLogin) (string, bool) { return "", false }
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
	Wrappable    bool        `json:"wrappable"`
	Offset       int         `json:"offset"`
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
	if !slices.Contains(h.Capabilities, CapDB) || !slices.Contains(h.Capabilities, CapDBPermissions) || !slices.Contains(h.Capabilities, CapDBSchema) || !slices.Contains(h.Capabilities, CapDBStructure) || !slices.Contains(h.Capabilities, CapDBElevate) {
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
		Keychain: func(context.Context, config.DBLogin) (string, bool) { return "keychain-secret", true },
		File:     func(config.DBLogin) (string, bool) { return "file-secret", true },
	}
	pw.Remember(dbtest.Login(conn), "typed-secret")
	c := dbServer(t, pw, conn)
	var raw json.RawMessage
	if err := c.Call(context.Background(), "db.connections", struct{}{}, &raw); err != nil {
		t.Fatal(err)
	}
	want := `{"connections":[{"name":"prod","variant":"","kind":"mysql","host":"db.example.com","port":3307,"user":"reader","database":"shop","readOnly":true,` +
		`"human":{"permission":"","run":"read"},"agent":{"permission":"","run":"none","propose":true,"user":"reader"}}],"problems":[]}`
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
			maps.Copy(p, extra)
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

// キーチェーン・ファイルで見つけたパスワードが通れば、何も聞かない。それを DB が断ったら password_required（rejected）で、
// 見つけた場所を返す。窓が聞いて渡したものが通れば覚え、次からは見つけたものより先に使う。
func TestDBPasswordFromMachine(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ctx := context.Background()
		for _, src := range []string{"keychain", "file"} {
			found := dbtest.Password
			find := func() (string, bool) { return found, true }
			pw := &db.Passwords{}
			if src == "keychain" {
				pw.Keychain = func(context.Context, config.DBLogin) (string, bool) { return find() }
			} else {
				pw.File = func(config.DBLogin) (string, bool) { return find() }
			}
			c := dbServer(t, pw, conn)
			query := func(extra map[string]any) error {
				p := map[string]any{"connection": conn.Name, "sql": "SELECT 1"}
				maps.Copy(p, extra)
				return c.Call(ctx, "db.query", p, nil)
			}
			if err := query(nil); err != nil {
				t.Errorf("%s: %v", src, err)
			}
			found = "wrong"
			if code, data := dbErr(t, query(nil)); code != rpc.CodePasswordRequired || data["reason"] != "rejected" || data["passwordSource"] != src {
				t.Errorf("%s with a wrong password: %d %v", src, code, data)
			}
			// 入力したものが断られたら、見つけた場所は付けない。
			if code, data := dbErr(t, query(map[string]any{"password": "also-wrong"})); code != rpc.CodePasswordRequired || data["reason"] != "rejected" || data["passwordSource"] != nil {
				t.Errorf("%s, a wrong typed password: %d %v", src, code, data)
			}
			if err := query(map[string]any{"password": dbtest.Password}); err != nil {
				t.Errorf("%s, the right typed password: %v", src, err)
			}
			// 覚えたものが、断られる見つけたものより先に使われる。
			if err := query(nil); err != nil {
				t.Errorf("%s, the remembered password: %v", src, err)
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
		// offset で、その行数の後のページを読む（SQL を包んで実行する。#373）。
		three := "SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3"
		res, err = call(map[string]any{"connection": conn.Name, "sql": three, "maxRows": 2})
		if err != nil || !res.Wrappable || res.Offset != 0 || !res.Truncated {
			t.Errorf("the first page: %+v, %v", res, err)
		}
		res, err = call(map[string]any{"connection": conn.Name, "sql": three, "maxRows": 2, "offset": 2})
		if err != nil || res.RowCount != 1 || res.Truncated || *res.Rows[0][0] != "3" || res.Offset != 2 || !res.Wrappable {
			t.Errorf("offset: %+v, %v", res, err)
		}
		if _, err := call(map[string]any{"connection": conn.Name, "sql": three, "offset": -1}); err.(*rpc.Error).Code != rpc.CodeInvalidParams {
			t.Errorf("a negative offset: %v", err)
		}
		_, err = call(map[string]any{"connection": conn.Name, "sql": "SHOW TIME ZONE", "offset": 2})
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" {
			t.Errorf("offset of a statement that cannot be wrapped: %v", err)
		}
		// orderBy は、結果の列の位置で全部の行を並べ替える。offset のページもその順の続き（#377）。
		res, err = call(map[string]any{"connection": conn.Name, "sql": three, "maxRows": 2, "orderBy": 1, "desc": true})
		if err != nil || res.RowCount != 2 || !res.Truncated || !res.Wrappable || *res.Rows[0][0] != "3" || *res.Rows[1][0] != "2" {
			t.Errorf("orderBy: %+v, %v", res, err)
		}
		res, err = call(map[string]any{"connection": conn.Name, "sql": three, "maxRows": 2, "orderBy": 1, "desc": true, "offset": 2})
		if err != nil || res.RowCount != 1 || *res.Rows[0][0] != "1" {
			t.Errorf("orderBy with offset: %+v, %v", res, err)
		}
		if _, err := call(map[string]any{"connection": conn.Name, "sql": three, "orderBy": -1}); err.(*rpc.Error).Code != rpc.CodeInvalidParams {
			t.Errorf("a negative orderBy: %v", err)
		}
		_, err = call(map[string]any{"connection": conn.Name, "sql": "SHOW TIME ZONE", "orderBy": 1})
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" {
			t.Errorf("orderBy of a statement that cannot be wrapped: %v", err)
		}
		// schema は、スキーマを書かない名前を先に探すスキーマ（#378）。どのユーザーにもあるスキーマで確かめる。
		which, schema := "SELECT current_schema()", "pg_catalog"
		if conn.Kind == config.DBMySQL {
			which, schema = "SELECT DATABASE()", "information_schema"
		}
		res, err = call(map[string]any{"connection": conn.Name, "sql": which, "schema": schema})
		if err != nil || res.RowCount != 1 || *res.Rows[0][0] != schema {
			t.Errorf("schema: %+v, %v", res, err)
		}
		res, err = call(map[string]any{"connection": conn.Name, "sql": which})
		if err != nil || res.RowCount != 1 || res.Rows[0][0] == nil || *res.Rows[0][0] == schema {
			t.Errorf("without schema: %+v, %v", res, err)
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
	pw := &db.Passwords{File: func(config.DBLogin) (string, bool) { return dbtest.Password, true }}
	pw.Keychain = func(context.Context, config.DBLogin) (string, bool) { return "", false }
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

// dbServerAt は dbServer に、SQL の履歴を置くフォルダを足したもの。パスワードは dbtest のものがファイルにあることにする。
func dbServerAt(t *testing.T, historyDir string, conns ...config.DBConnection) *rpc.Conn {
	t.Helper()
	pw := &db.Passwords{
		Keychain: func(context.Context, config.DBLogin) (string, bool) { return "", false },
		File:     func(config.DBLogin) (string, bool) { return dbtest.Password, true },
	}
	_, sock := startWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return conns, nil }
		o.DBPasswords = pw
		o.DBHistoryDir = historyDir
	})
	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	return c
}

// db.schema は、スキーマ・テーブル（ビューを含む）・列の一覧を返す。パスワードの扱いは db.query と同じ。
func TestDBSchema(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		c := dbServer(t, nil, conn)
		ctx := context.Background()
		// パスワードが無ければ password_required。
		err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name}, nil)
		if code, data := dbErr(t, err); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
			t.Errorf("without a password: %v", err)
		}
		for _, sql := range []string{"DROP VIEW IF EXISTS srv_schema_v", "DROP TABLE IF EXISTS srv_schema_t", "CREATE TABLE srv_schema_t (id INT, word VARCHAR(5))", "CREATE VIEW srv_schema_v AS SELECT id FROM srv_schema_t"} {
			if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": sql, "password": dbtest.Password}, nil); err != nil {
				t.Fatal(err)
			}
		}
		var res struct {
			Schemas []struct {
				Name   string `json:"name"`
				Tables []struct {
					Name    string `json:"name"`
					Kind    string `json:"kind"`
					Columns []struct {
						Name string `json:"name"`
						Type string `json:"type"`
					} `json:"columns"`
				} `json:"tables"`
			} `json:"schemas"`
			Truncated *bool `json:"truncated"`
		}
		// 窓から渡されて通ったパスワードは覚えているので、password 無しで通る。
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name}, &res); err != nil {
			t.Fatal(err)
		}
		want := "public"
		if conn.Kind == config.DBMySQL {
			want = "kisui"
		}
		found := map[string]string{}
		for _, s := range res.Schemas {
			if s.Name != want {
				continue
			}
			for _, tb := range s.Tables {
				var cols []string
				for _, col := range tb.Columns {
					cols = append(cols, col.Name+" "+col.Type)
				}
				found[tb.Name] = tb.Kind + ": " + strings.Join(cols, ", ")
			}
		}
		wantT, wantV := "table: id integer, word character varying(5)", "view: id integer"
		if conn.Kind == config.DBMySQL {
			wantT, wantV = "table: id int, word varchar(5)", "view: id int"
		}
		if found["srv_schema_t"] != wantT || found["srv_schema_v"] != wantV || res.Truncated == nil || *res.Truncated {
			t.Errorf("schema %s: %v (%+v)", want, found, res)
		}
		// 設定に無い接続は not_found。
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": "nope"}, nil); err.(*rpc.Error).Code != rpc.CodeNotFound {
			t.Errorf("unknown connection: %v", err)
		}
	})
}

// db.structure は、1 つのテーブルの列・インデックス・外部キーを返す（#379）。パスワードの扱いは db.query と同じ。
func TestDBStructure(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		c := dbServer(t, nil, conn)
		ctx := context.Background()
		schema := "public"
		if conn.Kind == config.DBMySQL {
			schema = "kisui"
		}
		params := map[string]any{"connection": conn.Name, "schema": schema, "table": "srv_st_c"}
		// パスワードが無ければ password_required。
		err := c.Call(ctx, "db.structure", params, nil)
		if code, data := dbErr(t, err); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
			t.Errorf("without a password: %v", err)
		}
		for _, sql := range []string{
			"DROP TABLE IF EXISTS srv_st_c", "DROP TABLE IF EXISTS srv_st_p",
			"CREATE TABLE srv_st_p (id INT PRIMARY KEY)",
			"CREATE TABLE srv_st_c (id INT NOT NULL PRIMARY KEY, p INT DEFAULT 1, CONSTRAINT srv_st_fk FOREIGN KEY (p) REFERENCES srv_st_p (id))",
		} {
			if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": sql, "password": dbtest.Password}, nil); err != nil {
				t.Fatal(err)
			}
		}
		var res struct {
			Columns []struct {
				Name     string  `json:"name"`
				Nullable bool    `json:"nullable"`
				Default  *string `json:"default"`
			} `json:"columns"`
			Indexes []struct {
				Columns []string `json:"columns"`
				Primary bool     `json:"primary"`
			} `json:"indexes"`
			ForeignKeys []struct {
				Name       string   `json:"name"`
				Columns    []string `json:"columns"`
				RefTable   string   `json:"refTable"`
				RefColumns []string `json:"refColumns"`
			} `json:"foreignKeys"`
			Truncated *bool `json:"truncated"`
		}
		// 窓から渡されて通ったパスワードは覚えているので、password 無しで通る。
		if err := c.Call(ctx, "db.structure", params, &res); err != nil {
			t.Fatal(err)
		}
		if len(res.Columns) != 2 || res.Columns[0].Name != "id" || res.Columns[0].Nullable || res.Columns[0].Default != nil ||
			res.Columns[1].Name != "p" || !res.Columns[1].Nullable || res.Columns[1].Default == nil || res.Truncated == nil || *res.Truncated {
			t.Errorf("columns: %+v", res)
		}
		if len(res.Indexes) == 0 || !res.Indexes[0].Primary || !reflect.DeepEqual(res.Indexes[0].Columns, []string{"id"}) {
			t.Errorf("indexes: %+v", res.Indexes)
		}
		if len(res.ForeignKeys) != 1 || res.ForeignKeys[0].Name != "srv_st_fk" || res.ForeignKeys[0].RefTable != "srv_st_p" ||
			!reflect.DeepEqual(res.ForeignKeys[0].Columns, []string{"p"}) || !reflect.DeepEqual(res.ForeignKeys[0].RefColumns, []string{"id"}) {
			t.Errorf("foreign keys: %+v", res.ForeignKeys)
		}
		// 無いテーブルは db_error（kind は query）。
		err = c.Call(ctx, "db.structure", map[string]any{"connection": conn.Name, "schema": schema, "table": "srv_st_nothing"}, nil)
		if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" {
			t.Errorf("no such table: %v", err)
		}
		// テーブルを省けば invalid_params、設定に無い接続は not_found。
		if err := c.Call(ctx, "db.structure", map[string]any{"connection": conn.Name, "schema": schema}, nil); err.(*rpc.Error).Code != rpc.CodeInvalidParams {
			t.Errorf("without a table: %v", err)
		}
		if err := c.Call(ctx, "db.structure", map[string]any{"connection": "nope", "schema": schema, "table": "srv_st_c"}, nil); err.(*rpc.Error).Code != rpc.CodeNotFound {
			t.Errorf("unknown connection: %v", err)
		}
	})
}

// SQL を実行すると、その接続の履歴に足される。serve を起動し直しても残り、ほかの接続の履歴には出ない。
func TestDBHistory(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		dir := t.TempDir()
		other := conn
		other.Name = conn.Name + "-other"
		ctx := context.Background()
		type entry struct {
			SQL string `json:"sql"`
			At  string `json:"at"`
			OK  bool   `json:"ok"`
		}
		history := func(c *rpc.Conn, name string, limit int) []entry {
			t.Helper()
			var res struct {
				Entries []entry `json:"entries"`
			}
			if err := c.Call(ctx, "db.history", map[string]any{"connection": name, "limit": limit}, &res); err != nil {
				t.Fatal(err)
			}
			return res.Entries
		}

		c := dbServerAt(t, dir, conn, other)
		if got := history(c, conn.Name, 0); got == nil || len(got) != 0 {
			t.Errorf("before any statement: %#v", got)
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1"}, nil); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELEC 2"}, nil); err == nil {
			t.Fatal("a wrong statement passed")
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": other.Name, "sql": "SELECT 3"}, nil); err != nil {
			t.Fatal(err)
		}
		// ページを切り替えるための実行（offset あり）は履歴に残らない。
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 4", "offset": 1}, nil); err != nil {
			t.Fatal(err)
		}
		// 並べ替えのための実行（orderBy あり）と、読み直すだけの実行（rerun。並べ替えをやめる・先頭のページに戻る）も残らない（#377）。
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 5", "orderBy": 1, "desc": true}, nil); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 6", "rerun": true}, nil); err != nil {
			t.Fatal(err)
		}
		// db.schema は履歴に残らない。
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name}, nil); err != nil {
			t.Fatal(err)
		}
		c.Close()

		// 起動し直した serve でも、同じ履歴が新しい順に返る。
		c = dbServerAt(t, dir, conn, other)
		got := history(c, conn.Name, 0)
		if len(got) != 2 || got[0].SQL != "SELEC 2" || got[0].OK || got[1].SQL != "SELECT 1" || !got[1].OK {
			t.Fatalf("history: %+v", got)
		}
		if _, err := time.Parse(time.RFC3339Nano, got[0].At); err != nil {
			t.Errorf("at: %v", err)
		}
		if got := history(c, other.Name, 0); len(got) != 1 || got[0].SQL != "SELECT 3" {
			t.Errorf("the other connection: %+v", got)
		}
		if got := history(c, conn.Name, 1); len(got) != 1 || got[0].SQL != "SELEC 2" {
			t.Errorf("limit: %+v", got)
		}
		if err := c.Call(ctx, "db.history", map[string]any{"connection": "nope"}, nil); err.(*rpc.Error).Code != rpc.CodeNotFound {
			t.Errorf("unknown connection: %v", err)
		}
		if err := c.Call(ctx, "db.history", map[string]any{"connection": conn.Name, "limit": -1}, nil); err.(*rpc.Error).Code != rpc.CodeInvalidParams {
			t.Errorf("negative limit: %v", err)
		}
	})
}

// ログインできなかった SQL は実行していないので、履歴に残らない。
func TestDBHistoryOnlyWhatRan(t *testing.T) {
	conn := dbtest.Postgres(t)
	dir := t.TempDir()
	_, sock := startWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return []config.DBConnection{conn}, nil }
		o.DBPasswords = &db.Passwords{
			Keychain: func(context.Context, config.DBLogin) (string, bool) { return "", false },
			File:     func(config.DBLogin) (string, bool) { return "", false },
		}
		o.DBHistoryDir = dir
	})
	c := dial(t, sock)
	ctx := context.Background()
	if err := c.Call(ctx, "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	_ = c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1"}, nil)
	_ = c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 2", "password": "wrong"}, nil)
	var res struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err := c.Call(ctx, "db.history", map[string]any{"connection": conn.Name}, &res); err != nil || len(res.Entries) != 0 {
		t.Errorf("%s, %v", res.Entries, err)
	}
}

// 環境の変種のある接続は、一覧に変種ごとに出て、要求は名前と変種で指す。変種を付けない要求と、無い変種は not_found。
// 履歴は変種ごとに別で、変種の無い同じ名前の接続（変種を書く前の履歴）とも混ざらない。
func TestDBVariants(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ctx := context.Background()
		local, prod := conn, conn
		local.Variant, prod.Variant = "local", "prod"
		prod.ReadOnly = true
		dir := t.TempDir()
		// 変種を書く前に、同じ名前の接続で実行した SQL。
		c := dbServerAt(t, dir, conn)
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 0"}, nil); err != nil {
			t.Fatal(err)
		}
		c.Close()

		c = dbServerAt(t, dir, local, prod)
		var list DBConnectionsResult
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Connections) != 2 || list.Connections[0].Name != conn.Name || list.Connections[0].Variant != "local" ||
			list.Connections[1].Name != conn.Name || list.Connections[1].Variant != "prod" || !list.Connections[1].ReadOnly {
			t.Fatalf("connections: %+v", list.Connections)
		}
		for _, method := range []string{"db.query", "db.schema", "db.history"} {
			for name, variant := range map[string]string{"no variant": "", "unknown variant": "stg"} {
				err := c.Call(ctx, method, map[string]any{"connection": conn.Name, "variant": variant, "sql": "SELECT 1"}, nil)
				if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeNotFound {
					t.Errorf("%s, %s: %v", method, name, err)
				}
			}
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "local", "sql": "SELECT 1"}, nil); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "prod", "sql": "SELECT 2"}, nil); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name, "variant": "prod"}, nil); err != nil {
			t.Fatal(err)
		}
		// 変種の read-only は、その変種だけに効く。
		err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "prod", "sql": "CREATE TABLE kisui_variant_ro (a int)"}, nil)
		if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeDBError {
			t.Errorf("a write on the read-only variant: %v", err)
		}
		for variant, want := range map[string][]string{"local": {"SELECT 1"}, "prod": {"CREATE TABLE kisui_variant_ro (a int)", "SELECT 2"}} {
			var res struct {
				Entries []struct {
					SQL string `json:"sql"`
				} `json:"entries"`
			}
			if err := c.Call(ctx, "db.history", map[string]any{"connection": conn.Name, "variant": variant}, &res); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, e := range res.Entries {
				got = append(got, e.SQL)
			}
			if !slices.Equal(got, want) {
				t.Errorf("history of %s: %q, want %q", variant, got, want)
			}
		}
	})
}

// 窓で入力して通ったパスワードは、変種ごとに覚える：ある変種で通ったものを、別の変種に送らない。
func TestDBPasswordPerVariant(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ctx := context.Background()
		local, prod := conn, conn
		local.Variant, prod.Variant = "local", "prod"
		c := dbServer(t, nil, local, prod)
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "local", "sql": "SELECT 1", "password": dbtest.Password}, nil); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "local", "sql": "SELECT 1"}, nil); err != nil {
			t.Errorf("the remembered password of the variant: %v", err)
		}
		err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": "prod", "sql": "SELECT 1"}, nil)
		if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodePasswordRequired {
			t.Errorf("the other variant: %v", err)
		}
	})
}
