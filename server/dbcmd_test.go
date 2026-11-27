package server

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// dbCmdServer は、接続 conns を設定に持つ serve と、その GUI の役（c・nt）と、ペインの中のコマンドの役（do）を用意する。
// password は、ファイル（~/.pgpass など）にあることにするパスワード（nil なら、どこにも無い）。
func dbCmdServer(t *testing.T, password *string, conns ...config.DBConnection) (srv *Server, sock string, c *rpc.Conn, nt *notes, do func(panecmd.Request) panecmd.Reply) {
	t.Helper()
	t.Setenv("HOME", normalizePath(t.TempDir()))
	pw := &db.Passwords{
		Keychain: func(context.Context, config.DBLogin) (string, bool) { return "", false },
		File: func(config.DBLogin) (string, bool) {
			if password == nil {
				return "", false
			}
			return *password, true
		},
	}
	srv, sock = startFastWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return conns, nil }
		o.DBPasswords = pw
		o.DBHistoryDir = t.TempDir()
	})
	c, nt = termClient(t, sock)
	_, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	return srv, sock, c, nt, func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = primary, token
		return paneCmdDo(t, sock, rq)
	}
}

// kisui db のコマンドは、エージェントの権限の実行の段階に従う：「しない」と権限を書いていない接続は DB につながずに断り、
// 「読むだけ」は DB が書き込みを断り、「自由」は書ける。スキーマの一覧は、どの段階でも読める。実行した文は、エージェントの文として履歴に残る。
func TestDBCmdPermission(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		variant := func(name string, agent config.DBPermission) config.DBConnection {
			c := conn
			c.Variant, c.Agent = name, agent
			return c
		}
		password := dbtest.Password
		_, _, c, _, do := dbCmdServer(t, &password,
			variant("plain", config.DBPermission{}),
			variant("free", config.DBPermission{Name: "free", Run: config.DBRunFree}),
			variant("read", config.DBPermission{Name: "r", Run: config.DBRunRead}),
			variant("none", config.DBPermission{Name: "n", Run: config.DBRunNone}),
		)
		query := func(variant, sql string) (dbResult, panecmd.Reply) {
			r := do(panecmd.Request{Cmd: "db-query", Connection: conn.Name, Variant: variant, SQL: sql})
			var res dbResult
			if r.OK {
				if err := json.Unmarshal(r.DB, &res); err != nil {
					t.Fatal(err)
				}
			}
			return res, r
		}
		table := "t_server_dbcmd_perm"
		// 人（Window）が表を用意する。
		for _, sql := range []string{"DROP TABLE IF EXISTS " + table, "CREATE TABLE " + table + " (id INT)", "INSERT INTO " + table + " VALUES (1)"} {
			if err := c.Call(context.Background(), "db.query", map[string]any{"connection": conn.Name, "variant": "plain", "sql": sql}, nil); err != nil {
				t.Fatalf("%s: %v", sql, err)
			}
		}
		for _, v := range []string{"plain", "none"} {
			if _, r := query(v, "SELECT 1"); r.OK || r.Code != panecmd.CodeDenied || strings.Contains(r.Error, "rpc error") {
				t.Errorf("%s: SELECT: %+v", v, r)
			}
			var cat db.Catalog
			r := do(panecmd.Request{Cmd: "db-schema", Connection: conn.Name, Variant: v})
			if !r.OK || json.Unmarshal(r.DB, &cat) != nil || len(cat.Schemas) == 0 {
				t.Errorf("%s: db-schema: %+v", v, r)
			}
		}
		if _, r := query("read", "UPDATE "+table+" SET id = 3"); r.OK || r.Code != "" {
			t.Errorf("read: UPDATE: %+v", r)
		}
		if res, r := query("read", "SELECT id FROM "+table); !r.OK || len(res.Rows) != 1 || *res.Rows[0][0] != "1" {
			t.Errorf("read: SELECT: %+v %+v", res, r)
		}
		if res, r := query("free", "UPDATE "+table+" SET id = 2"); !r.OK || res.RowsAffected == nil || *res.RowsAffected != 1 {
			t.Errorf("free: UPDATE: %+v %+v", res, r)
		}
		// 行数の上限は、コマンドの MaxRows。
		if err := c.Call(context.Background(), "db.query", map[string]any{"connection": conn.Name, "variant": "plain", "sql": "INSERT INTO " + table + " VALUES (5), (6)"}, nil); err != nil {
			t.Fatal(err)
		}
		r := do(panecmd.Request{Cmd: "db-query", Connection: conn.Name, Variant: "free", SQL: "SELECT id FROM " + table, MaxRows: 2})
		var cut dbResult
		if !r.OK || json.Unmarshal(r.DB, &cut) != nil || len(cut.Rows) != 2 || !cut.Truncated {
			t.Errorf("MaxRows: %+v %+v", cut, r)
		}
		// 無い接続・変種を付けない指し方は not-found。別のマシンは指せない。
		for _, rq := range []panecmd.Request{
			{Cmd: "db-query", Connection: "nope", SQL: "SELECT 1"},
			{Cmd: "db-query", Connection: conn.Name, SQL: "SELECT 1"},
			{Cmd: "db-schema", Connection: conn.Name, Variant: "nope"},
			{Cmd: "db-propose", Connection: "nope", SQL: "SELECT 1"},
		} {
			if r := do(rq); r.OK || r.Code != panecmd.CodeNotFound {
				t.Errorf("%+v: %+v", rq, r)
			}
		}
		if r := do(panecmd.Request{Cmd: "db-connections", Machine: "dev"}); r.OK || !strings.Contains(r.Error, "does not take a machine") {
			t.Errorf("with a machine: %+v", r)
		}
		// 履歴：エージェントが DB に送った文は、エージェントの文として残る。断られて送らなかった文は残らない。
		type history struct {
			Entries []db.HistoryEntry `json:"entries"`
		}
		var free, human history
		if err := c.Call(context.Background(), "db.history", map[string]any{"connection": conn.Name, "variant": "free"}, &free); err != nil {
			t.Fatal(err)
		}
		if len(free.Entries) != 2 || free.Entries[1].Actor != "agent" || !strings.HasPrefix(free.Entries[1].SQL, "UPDATE") {
			t.Errorf("history of free: %+v", free.Entries)
		}
		if err := c.Call(context.Background(), "db.history", map[string]any{"connection": conn.Name, "variant": "plain"}, &human); err != nil {
			t.Fatal(err)
		}
		if len(human.Entries) != 4 {
			t.Errorf("history of plain: %+v", human.Entries)
		}
		for _, e := range human.Entries {
			if e.Actor != "" {
				t.Errorf("history of plain: a statement of the window is marked as the agent's: %+v", e)
			}
		}
	})
}

// 一覧は DB につながずに返し、エージェントにしてよいことが入っている。パスワードがどこにも無ければ、聞かずに断る。
func TestDBCmdConnectionsAndPassword(t *testing.T) {
	conn := dbtest.Postgres(t)
	conn.Agent = config.DBPermission{Name: "r", Run: config.DBRunRead, Propose: true}
	_, _, _, _, do := dbCmdServer(t, nil, conn)
	r := do(panecmd.Request{Cmd: "db-connections"})
	var list DBConnectionsResult
	if !r.OK || json.Unmarshal(r.DB, &list) != nil || len(list.Connections) != 1 {
		t.Fatalf("db-connections: %+v", r)
	}
	if got := list.Connections[0]; got.Name != conn.Name || got.Agent != (DBAgentAccess{Permission: "r", Run: config.DBRunRead, Propose: true, User: conn.User}) {
		t.Errorf("db-connections: %+v", got)
	}
	for _, cmd := range []string{"db-query", "db-schema"} {
		if r := do(panecmd.Request{Cmd: cmd, Connection: conn.Name, SQL: "SELECT 1"}); r.OK || r.Code != panecmd.CodePasswordRequired {
			t.Errorf("%s without a password: %+v", cmd, r)
		}
	}
}

// コマンドが切れたら（止められた）、動かしていた文を取り消す。
func TestDBCmdCancelledWhenTheCommandGoesAway(t *testing.T) {
	conn := dbtest.Postgres(t)
	conn.Agent = config.DBPermission{Name: "r", Run: config.DBRunRead}
	password := dbtest.Password
	srv, sock, _, _, _ := dbCmdServer(t, &password, conn)
	var primary string
	for _, tm := range srv.terms.all() {
		primary = tm.id
	}
	nc, err := net.Dial("unix", filepath.Join(filepath.Dir(sock), ctl.ServePrimaryName))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(panecmd.Request{Cmd: "db-query", Pane: primary, Token: termToken(t, srv, primary), Connection: conn.Name, SQL: "SELECT pg_sleep(60)"})
	if _, err := nc.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
	running := func() int {
		srv.db.mu.Lock()
		defer srv.db.mu.Unlock()
		return len(srv.db.running)
	}
	waitFor(t, "the statement runs", func() bool { return running() == 1 })
	// 接続の最初の 1 行を待つための期限（primaryConn の 5 秒）を過ぎても、コマンドが切れたことにはしない（文は動き続ける）
	time.Sleep(5200 * time.Millisecond)
	if running() != 1 {
		t.Fatal("the statement was cancelled while the command was still waiting")
	}
	nc.Close()
	waitFor(t, "the statement is cancelled", func() bool { return running() == 0 })
}

// kisui db propose は、権限が許すときだけ GUI に db.propose を通知し、GUI の db.proposed を待って返す。
// 権限を書いていない接続では書ける。人が断れば declined。答えが無ければ時間切れで断り、GUI に取り下げを知らせる。
func TestDBCmdPropose(t *testing.T) {
	conn := config.DBConnection{Name: "shop", Kind: config.DBPostgres, Host: "localhost", Port: 5432, User: "app"}
	variant := func(name string, agent config.DBPermission) config.DBConnection {
		c := conn
		c.Variant, c.Agent = name, agent
		return c
	}
	plain := conn
	plain.Name = "plain"
	_, _, c, nt, do := dbCmdServer(t, nil, plain,
		variant("yes", config.DBPermission{Name: "p", Run: config.DBRunNone, Propose: true}),
		variant("no", config.DBPermission{Name: "free", Run: config.DBRunFree}),
	)
	type proposeParams struct {
		ID         string `json:"id"`
		Connection string `json:"connection"`
		Variant    string `json:"variant"`
		SQL        string `json:"sql"`
	}
	// GUI の役：届いた db.propose の n 番目（1 から）の中身
	nth := func(n int) proposeParams {
		var p proposeParams
		waitFor(t, "db.propose", func() bool {
			all := nt.all("db.propose")
			if len(all) < n {
				return false
			}
			_ = json.Unmarshal(*all[n-1], &p)
			return true
		})
		return p
	}
	done := make(chan panecmd.Reply, 1)
	propose := func(connection, variant, sql string) {
		go func() {
			done <- do(panecmd.Request{Cmd: "db-propose", Connection: connection, Variant: variant, SQL: sql})
		}()
	}

	// 権限が許さなければ、GUI に頼まずに断る（実行は自由でも、入力欄に書くのは別）
	if r := do(panecmd.Request{Cmd: "db-propose", Connection: "shop", Variant: "no", SQL: "SELECT 1"}); r.OK || r.Code != panecmd.CodeDenied {
		t.Fatalf("without propose: %+v", r)
	}
	for _, sql := range []string{"", "  \n", strings.Repeat("x", maxProposeSQL+1), "a\x00b"} {
		if r := do(panecmd.Request{Cmd: "db-propose", Connection: "shop", Variant: "yes", SQL: sql}); r.OK {
			t.Fatalf("a bad SQL was taken: %d bytes", len(sql))
		}
	}
	if n := len(nt.all("db.propose")); n != 0 {
		t.Fatalf("asked the window %d times for what is refused", n)
	}

	// 書けた
	propose("shop", "yes", "UPDATE t SET a = 1")
	p := nth(1)
	if p.ID == "" || p.Connection != "shop" || p.Variant != "yes" || p.SQL != "UPDATE t SET a = 1" {
		t.Fatalf("db.propose: %+v", p)
	}
	if err := c.Notify("db.proposed", map[string]any{"id": p.ID, "status": "written"}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; !r.OK {
		t.Fatalf("written: %+v", r)
	}

	// 権限を書いていない接続（変種も無い）でも書ける。人が断れば declined
	propose("plain", "", "SELECT 2")
	p = nth(2)
	if p.Connection != "plain" || p.Variant != "" {
		t.Fatalf("db.propose of a connection without a permission: %+v", p)
	}
	if err := c.Notify("db.proposed", map[string]any{"id": p.ID, "status": "declined"}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; r.OK || r.Code != panecmd.CodeDeclined {
		t.Fatalf("declined: %+v", r)
	}

	// GUI が書けなければ（ワークスペースが無いなど）、その理由で断る
	propose("plain", "", "SELECT 3")
	p = nth(3)
	if err := c.Notify("db.proposed", map[string]any{"id": p.ID, "error": "there is no workspace"}); err != nil {
		t.Fatal(err)
	}
	if r := <-done; r.OK || r.Error != "there is no workspace" || r.Code != "" {
		t.Fatalf("refused by the window: %+v", r)
	}

	// 答えが無ければ時間切れで断り、GUI に取り下げを知らせる。遅れて来た答えは捨てる
	old := dbProposeWait
	dbProposeWait = 50 * time.Millisecond
	t.Cleanup(func() { dbProposeWait = old })
	propose("plain", "", "SELECT 4")
	p = nth(4)
	if r := <-done; r.OK || r.Error != errProposeTimeout.Error() {
		t.Fatalf("no answer: %+v", r)
	}
	waitFor(t, "db.proposeCancel", func() bool {
		all := nt.all("db.proposeCancel")
		var got struct {
			ID string `json:"id"`
		}
		return len(all) == 1 && json.Unmarshal(*all[0], &got) == nil && got.ID == p.ID
	})
	if err := c.Notify("db.proposed", map[string]any{"id": p.ID, "status": "written"}); err != nil {
		t.Fatal(err)
	}
}

// GUI がつながっていなければ、kisui db propose は断る。
func TestDBCmdProposeWithoutWindow(t *testing.T) {
	conn := config.DBConnection{Name: "shop", Kind: config.DBPostgres, Host: "localhost", Port: 5432, User: "app"}
	_, _, c, _, do := dbCmdServer(t, nil, conn)
	c.Close()
	var r panecmd.Reply
	waitFor(t, "the window is gone", func() bool {
		r = do(panecmd.Request{Cmd: "db-propose", Connection: "shop", SQL: "SELECT 1"})
		return !r.OK && r.Error == errNoWindow.Error()
	})
}
