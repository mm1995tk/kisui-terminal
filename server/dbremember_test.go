package server

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// rememberConn は、DB につながないテストの接続（設定に書いたことにするだけ）。
var rememberConn = config.DBConnection{Name: "shop", Kind: config.DBPostgres, Host: "db.example.com", Port: 5432, User: "app"}

// rememberServer は、conns を設定に書いたことにした serve。キーチェーンとパスワードのファイルは空。
// remembered は、serve が c の（人のログインの）パスワードを覚えているか。
func rememberServer(t *testing.T, conns ...config.DBConnection) (srv *Server, sock string, remembered func(c config.DBConnection) bool) {
	t.Helper()
	pw := &db.Passwords{
		Keychain: func(context.Context, config.DBLogin) (string, bool) { return "", false },
		File:     func(config.DBLogin) (string, bool) { return "", false },
	}
	srv, sock = startWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) { return conns, nil }
		o.DBPasswords = pw
	})
	return srv, sock, func(c config.DBConnection) bool {
		_, src, err := pw.Find(context.Background(), dbtest.Login(c), nil)
		return err == nil && src == db.SourceMemory
	}
}

// helloed は、session.hello を済ませた接続（持ち主になる）。
func helloed(t *testing.T, sock string) *rpc.Conn {
	t.Helper()
	c := dial(t, sock)
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	return c
}

// dbRemember は db.remember を送る：c の行き先で打ったパスワード password を渡し直す。
func dbRemember(t *testing.T, conn *rpc.Conn, c config.DBConnection, password string) (bool, error) {
	t.Helper()
	var r DBRememberResult
	err := conn.Call(context.Background(), "db.remember", map[string]any{
		"connection": c.Name, "variant": c.Variant, "kind": c.Kind, "host": c.Host, "port": c.Port, "user": c.User, "password": password,
	}, &r)
	return r.Remembered, err
}

// mustRemember は、db.remember が覚えることを確かめる。
func mustRemember(t *testing.T, conn *rpc.Conn, c config.DBConnection, password string) {
	t.Helper()
	if ok, err := dbRemember(t, conn, c, password); err != nil || !ok {
		t.Fatalf("db.remember: %v %v", ok, err)
	}
}

func TestDBRememberCapability(t *testing.T) {
	_, sock := start(t)
	var h HelloResult
	if err := dial(t, sock).Call(context.Background(), "session.hello", hello(Protocol.Major), &h); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(h.Capabilities, CapDBRemember) {
		t.Errorf("capabilities: %v", h.Capabilities)
	}
}

// 持ち主の Window の接続が切れたら、覚えたパスワードを全部忘れる。
func TestDBPasswordsForgottenWhenTheOwnerGoes(t *testing.T) {
	other := rememberConn
	other.Name = "logs"
	_, sock, remembered := rememberServer(t, rememberConn, other)
	c := helloed(t, sock)
	mustRemember(t, c, rememberConn, "one")
	mustRemember(t, c, other, "two")
	if !remembered(rememberConn) || !remembered(other) {
		t.Fatal("not remembered")
	}
	c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for remembered(rememberConn) || remembered(other) {
		if time.Now().After(deadline) {
			t.Fatal("still remembered after the owner went away")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 別の接続が session.hello で持ち主になったら、その返事より前に、覚えたパスワードを全部忘れる。
// 新しい持ち主の要求は、前の持ち主の Window で打ったパスワードを使えない。
func TestDBPasswordsForgottenWhenAnotherTakesOver(t *testing.T) {
	_, sock, remembered := rememberServer(t, rememberConn)
	first := helloed(t, sock)
	mustRemember(t, first, rememberConn, "typed")
	if !remembered(rememberConn) {
		t.Fatal("not remembered")
	}
	second := helloed(t, sock)
	if remembered(rememberConn) {
		t.Fatal("still remembered after another connection took over")
	}
	err := second.Call(context.Background(), "db.query", map[string]any{"connection": rememberConn.Name, "sql": "SELECT 1"}, nil)
	if code, data := dbErr(t, err); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
		t.Errorf("db.query of the new owner: %d %v", code, data)
	}
}

// 同じ接続からの session.hello のやり直しは入れ替わりではないので、忘れない。
func TestDBPasswordsKeptOnHelloAgain(t *testing.T) {
	_, sock, remembered := rememberServer(t, rememberConn)
	c := helloed(t, sock)
	mustRemember(t, c, rememberConn, "typed")
	if err := c.Call(context.Background(), "session.hello", hello(Protocol.Major), nil); err != nil {
		t.Fatal(err)
	}
	if !remembered(rememberConn) {
		t.Error("forgotten by a second hello of the same connection")
	}
}

// 持ち主でない接続（切れた・入れ替わった）の、返事を待っていた要求が後から通っても、覚え直さない。
func TestDBPasswordNotRememberedForAFormerOwner(t *testing.T) {
	srv, sock, remembered := rememberServer(t, rememberConn)
	helloed(t, sock)
	srv.mu.Lock()
	first := srv.owner
	srv.mu.Unlock()
	login := dbtest.Login(rememberConn)
	if !srv.rememberDBPassword(first, login, "typed") || !remembered(rememberConn) {
		t.Fatal("the owner's password was not remembered")
	}
	helloed(t, sock)
	if srv.rememberDBPassword(first, login, "typed") || remembered(rememberConn) {
		t.Error("remembered for a connection that is no longer the owner")
	}
	// ペインの中のコマンド（kisui db）の頼みは、Window の接続を持たない。
	if srv.rememberDBPassword(nil, login, "typed") || remembered(rememberConn) {
		t.Error("remembered without a window")
	}
}

// db.remember は、今の設定の接続が、パスワードを打ったときと同じ行き先（種類・ホスト・ポート・ユーザー）のときだけ覚える。
// 接続の名前が同じでも、設定を書き換えたあとは覚えない（別のサーバーにパスワードを送らない）。
func TestDBRememberOnlyForTheSameServer(t *testing.T) {
	local, prod := rememberConn, rememberConn
	local.Name, prod.Name = "env", "env"
	local.Variant, prod.Variant = "local", "prod"
	prod.Host = "prod.example.com"
	_, sock, remembered := rememberServer(t, rememberConn, local, prod)
	c := helloed(t, sock)

	changed := map[string]func(*config.DBConnection){
		"host": func(c *config.DBConnection) { c.Host = "evil.example.com" },
		"port": func(c *config.DBConnection) { c.Port = 6543 },
		"user": func(c *config.DBConnection) { c.User = "admin" },
		"kind": func(c *config.DBConnection) { c.Kind = config.DBMySQL },
		"name": func(c *config.DBConnection) { c.Name = "nosuch" },
	}
	for what, change := range changed {
		was := rememberConn
		change(&was)
		if ok, err := dbRemember(t, c, was, "typed"); err != nil || ok {
			t.Errorf("another %s: %v %v", what, ok, err)
		}
		if remembered(rememberConn) {
			t.Errorf("another %s: remembered", what)
		}
	}

	// 変種ごとに別のもの：ある変種で打ったものを、別の変種に覚えない。
	mustRemember(t, c, local, "typed")
	if !remembered(local) || remembered(prod) {
		t.Errorf("variants: local %v, prod %v", remembered(local), remembered(prod))
	}
	// 変種 local の行き先のまま、変種の名前だけを prod にしても覚えない。
	was := local
	was.Variant = "prod"
	if ok, err := dbRemember(t, c, was, "typed"); err != nil || ok || remembered(prod) {
		t.Errorf("the server of another variant: %v %v", ok, err)
	}

	// password を省くと断る（空文字はパスワード）。
	err := c.Call(context.Background(), "db.remember", map[string]any{"connection": rememberConn.Name, "kind": rememberConn.Kind, "host": rememberConn.Host, "port": rememberConn.Port, "user": rememberConn.User}, nil)
	if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeInvalidParams {
		t.Errorf("without a password: %v", err)
	}
	mustRemember(t, c, rememberConn, "")
	if !remembered(rememberConn) {
		t.Error("an empty password was not remembered")
	}
}

// hello の前・持ち主でなくなった接続の db.remember は断る。
func TestDBRememberOnlyFromTheOwner(t *testing.T) {
	_, sock, remembered := rememberServer(t, rememberConn)
	c := dial(t, sock)
	if _, err := dbRemember(t, c, rememberConn, "typed"); err == nil {
		t.Error("db.remember before hello")
	}
	if remembered(rememberConn) {
		t.Error("remembered before hello")
	}
}

// Window で打って通ったパスワードで、エージェントの kisui db のコマンドが通る。Window の接続が切れると通らなくなり、
// Window がつなぎ直して db.remember で渡し直すと、人が打ち直さなくてもまた通る。渡し直したものを DB が断ったら忘れる。
func TestDBCmdUsesTheWindowPasswordWhileItIsConnected(t *testing.T) {
	conn := dbtest.Postgres(t)
	conn.Agent = config.DBPermission{Name: "r", Run: config.DBRunRead, Propose: true}
	_, sock, c, _, do := dbCmdServer(t, nil, conn)
	ctx := context.Background()
	agent := func() panecmd.Reply {
		return do(panecmd.Request{Cmd: "db-query", Connection: conn.Name, SQL: "SELECT 1"})
	}
	if r := agent(); r.OK || r.Code != panecmd.CodePasswordRequired {
		t.Fatalf("before the window typed a password: %+v", r)
	}
	if err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1", "password": dbtest.Password}, nil); err != nil {
		t.Fatal(err)
	}
	if r := agent(); !r.OK {
		t.Fatalf("with the password typed in the window: %+v", r)
	}

	c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		r := agent()
		if !r.OK && r.Code == panecmd.CodePasswordRequired {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the window went away: %+v", r)
		}
		time.Sleep(5 * time.Millisecond)
	}

	again := helloed(t, sock)
	if r := agent(); r.OK || r.Code != panecmd.CodePasswordRequired {
		t.Fatalf("after the window came back, before db.remember: %+v", r)
	}
	mustRemember(t, again, conn, dbtest.Password)
	if r := agent(); !r.OK {
		t.Fatalf("after db.remember: %+v", r)
	}
	if err := again.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1"}, nil); err != nil {
		t.Errorf("the window, after db.remember: %v", err)
	}

	// 渡し直したパスワードを DB が断ったら、覚えたものを忘れて password_required（rejected）。次は missing。
	mustRemember(t, again, conn, "wrong")
	query := func() error {
		return again.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "sql": "SELECT 1"}, nil)
	}
	if code, data := dbErr(t, query()); code != rpc.CodePasswordRequired || data["reason"] != "rejected" || data["passwordSource"] != nil {
		t.Errorf("a wrong password from db.remember: %d %v", code, data)
	}
	if code, data := dbErr(t, query()); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
		t.Errorf("after it was refused: %d %v", code, data)
	}
}
