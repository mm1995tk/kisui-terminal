package server

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db"
	"github.com/mm1995tk/kisui-terminal/internal/panecmd"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// elevateEnv は、権限を強めるテストの舞台：進められる時計と、書き換えられる設定を持つ serve。DB は要らない：
// パスワードをどこにも置かないので、権限が実行を許せば password_required（DB につなぐ手前）、許さなければ denied になる。
type elevateEnv struct {
	t  *testing.T
	c  *rpc.Conn
	do func(panecmd.Request) panecmd.Reply

	mu    sync.Mutex
	now   time.Time
	conns []config.DBConnection
}

func (e *elevateEnv) advance(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.now = e.now.Add(d)
}

func (e *elevateEnv) setConns(conns ...config.DBConnection) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.conns = conns
}

func newElevateEnv(t *testing.T, conns ...config.DBConnection) *elevateEnv {
	t.Helper()
	t.Setenv("HOME", normalizePath(t.TempDir()))
	e := &elevateEnv{t: t, now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), conns: conns}
	pw := &db.Passwords{
		Keychain: func(context.Context, config.DBLogin) (string, bool) { return "", false },
		File:     func(config.DBLogin) (string, bool) { return "", false },
	}
	srv, sock := startFastWith(t, func(o *Options) {
		o.DBConnections = func() ([]config.DBConnection, []config.Problem) {
			e.mu.Lock()
			defer e.mu.Unlock()
			return e.conns, nil
		}
		o.DBPasswords = pw
		o.Now = func() time.Time {
			e.mu.Lock()
			defer e.mu.Unlock()
			return e.now
		}
	})
	c, _ := termClient(t, sock)
	_, primary := createWS(t, c)
	token := termToken(t, srv, primary)
	e.c = c
	e.do = func(rq panecmd.Request) panecmd.Reply {
		rq.Pane, rq.Token = primary, token
		return paneCmdDo(t, sock, rq)
	}
	return e
}

// humanMay は、人の db.query が権限に許されるか（許されれば password_required、許されなければ denied）。
func (e *elevateEnv) humanMay(variant string) bool {
	e.t.Helper()
	err := e.c.Call(context.Background(), "db.query", map[string]any{"connection": "shop", "variant": variant, "sql": "SELECT 1"}, nil)
	switch code, _ := dbErr(e.t, err); code {
	case rpc.CodePasswordRequired:
		return true
	case rpc.CodeDenied:
		return false
	}
	e.t.Fatalf("human, %s: %v", variant, err)
	return false
}

// agentMay は、kisui db query（コーディングエージェント）が権限に許されるか。
func (e *elevateEnv) agentMay(variant string) bool {
	e.t.Helper()
	r := e.do(panecmd.Request{Cmd: "db-query", Connection: "shop", Variant: variant, SQL: "SELECT 1"})
	switch r.Code {
	case panecmd.CodePasswordRequired:
		return true
	case panecmd.CodeDenied:
		return false
	}
	e.t.Fatalf("agent, %s: %+v", variant, r)
	return false
}

func (e *elevateEnv) elevate(method string, params map[string]any) (DBConnectionInfo, error) {
	var res DBElevateResult
	err := e.c.Call(context.Background(), method, params, &res)
	return res.Connection, err
}

func (e *elevateEnv) info(variant string) DBConnectionInfo {
	e.t.Helper()
	var list DBConnectionsResult
	if err := e.c.Call(context.Background(), "db.connections", struct{}{}, &list); err != nil {
		e.t.Fatal(err)
	}
	for _, c := range list.Connections {
		if c.Variant == variant {
			return c
		}
	}
	e.t.Fatalf("no variant %s", variant)
	return DBConnectionInfo{}
}

// 強められる権限の組：off（しない）は reader（読むだけ）に 30 分まで、reader は free（自由）に 1 時間まで。
var (
	elevFree   = config.DBPermission{Name: "free", Run: config.DBRunFree}
	elevReader = config.DBPermission{Name: "reader", Run: config.DBRunRead, ElevateTo: "free", ElevateMax: time.Hour}
	elevOff    = config.DBPermission{Name: "off", Run: config.DBRunNone, ElevateTo: "reader", ElevateMax: 30 * time.Minute}
)

func elevConn(variant string) config.DBConnection {
	return config.DBConnection{Name: "shop", Variant: variant, Kind: config.DBPostgres, Host: "localhost", Port: 1, User: "app",
		Human: elevOff, HumanElevate: elevReader, Agent: elevOff, AgentElevate: elevReader}
}

// db.elevate は、時間を決めて権限を強める：その接続の変種の、頼んだ相手（人かエージェント）だけが強まり、
// 時間が過ぎると元に戻る。db.connections は、強められること・今強めていることを返す。
func TestDBElevate(t *testing.T) {
	e := newElevateEnv(t, elevConn("prod"), elevConn("dev"))
	if e.humanMay("prod") || e.agentMay("prod") {
		t.Fatal("allowed before elevating")
	}
	if i := e.info("prod"); i.Human.Elevate == nil || *i.Human.Elevate != (DBElevate{To: "reader", Run: config.DBRunRead, MaxSeconds: 1800}) || i.Human.Elevated != nil || i.Agent.Elevate == nil || i.Agent.Elevated != nil {
		t.Errorf("before: %+v", i)
	}
	// 人の権限を 10 分強める。
	i, err := e.elevate("db.elevate", map[string]any{"connection": "shop", "variant": "prod", "actor": "human", "duration": "10m"})
	if err != nil {
		t.Fatal(err)
	}
	if i.Human.Permission != "reader" || i.Human.Run != config.DBRunRead || !i.ReadOnly || i.Human.Elevated == nil || i.Human.Elevated.From != "off" || i.Human.Elevated.RemainingSeconds != 600 || i.Human.Elevate == nil {
		t.Errorf("elevated: %+v %+v", i.Human, i.Human.Elevated)
	}
	if i.Agent.Elevated != nil || i.Agent.Run != config.DBRunNone {
		t.Errorf("the agent beside an elevated human: %+v", i.Agent)
	}
	if !e.humanMay("prod") {
		t.Error("human, prod: not allowed while elevated")
	}
	// ほかの変種と、エージェントは変わらない。
	if e.humanMay("dev") || e.agentMay("prod") {
		t.Error("another variant or the agent was elevated too")
	}
	// 残りの時間は減る。時間が過ぎたら元に戻る。
	e.advance(9*time.Minute + 30*time.Second + 500*time.Millisecond)
	if i := e.info("prod"); i.Human.Elevated == nil || i.Human.Elevated.RemainingSeconds != 30 {
		t.Errorf("remaining: %+v", i.Human.Elevated)
	}
	e.advance(30 * time.Second)
	if e.humanMay("prod") {
		t.Error("human, prod: still allowed after the time")
	}
	if i := e.info("prod"); i.Human.Elevated != nil || i.Human.Permission != "off" {
		t.Errorf("after the time: %+v", i.Human)
	}

	// エージェントの権限を強めるのも、窓の要求。
	if _, err := e.elevate("db.elevate", map[string]any{"connection": "shop", "variant": "prod", "actor": "agent", "duration": "30m"}); err != nil {
		t.Fatal(err)
	}
	if !e.agentMay("prod") || e.humanMay("prod") || e.agentMay("dev") {
		t.Error("the agent's permission: not as elevated")
	}
	// もう強めているものは、今からの時間に決め直す（縮めることもできる）。
	e.advance(20 * time.Minute)
	if i, err := e.elevate("db.elevate", map[string]any{"connection": "shop", "variant": "prod", "actor": "agent", "duration": "1m"}); err != nil || i.Agent.Elevated == nil || i.Agent.Elevated.RemainingSeconds != 60 {
		t.Errorf("again: %+v, %v", i.Agent.Elevated, err)
	}
	// db.elevateEnd は、時間の前に戻す。強めていなくても間違いにしない。
	for range 2 {
		if i, err := e.elevate("db.elevateEnd", map[string]any{"connection": "shop", "variant": "prod", "actor": "agent"}); err != nil || i.Agent.Elevated != nil || i.Agent.Run != config.DBRunNone {
			t.Errorf("db.elevateEnd: %+v, %v", i.Agent, err)
		}
	}
	if e.agentMay("prod") {
		t.Error("agent, prod: still allowed after db.elevateEnd")
	}
}

// db.elevate の断り方：上限を超える時間・強められない権限は denied、時間の書き方・誰の権限かの間違いは invalid_params。
func TestDBElevateRefused(t *testing.T) {
	fixed := elevConn("fixed")
	fixed.Human, fixed.HumanElevate = elevFree, config.DBPermission{}
	fixed.Agent, fixed.AgentElevate = config.DBPermission{}, config.DBPermission{}
	e := newElevateEnv(t, elevConn("prod"), fixed)
	call := func(params map[string]any) (int, map[string]any) {
		_, err := e.elevate("db.elevate", params)
		return dbErr(t, err)
	}
	if code, data := call(map[string]any{"connection": "shop", "variant": "prod", "actor": "human", "duration": "30m1s"}); code != rpc.CodeDenied || data["reason"] != "over_max" || data["maxSeconds"] != float64(1800) {
		t.Errorf("over the limit: %d %v", code, data)
	}
	for _, actor := range []string{"human", "agent"} {
		if code, data := call(map[string]any{"connection": "shop", "variant": "fixed", "actor": actor, "duration": "1m"}); code != rpc.CodeDenied || data["reason"] != "not_elevatable" {
			t.Errorf("%s, no elevate-to: %d %v", actor, code, data)
		}
	}
	for name, params := range map[string]map[string]any{
		"no duration":   {"connection": "shop", "variant": "prod", "actor": "human"},
		"a bad time":    {"connection": "shop", "variant": "prod", "actor": "human", "duration": "30"},
		"no actor":      {"connection": "shop", "variant": "prod", "duration": "1m"},
		"unknown actor": {"connection": "shop", "variant": "prod", "actor": "robot", "duration": "1m"},
	} {
		if code, _ := call(params); code != rpc.CodeInvalidParams {
			t.Errorf("%s: %d", name, code)
		}
	}
	if code, _ := call(map[string]any{"connection": "shop", "variant": "nowhere", "actor": "human", "duration": "1m"}); code != rpc.CodeNotFound {
		t.Errorf("no such variant: %d", code)
	}
	// 断ったものは、何も強めていない。
	if e.humanMay("prod") {
		t.Error("elevated by a refused request")
	}
	// ペインの中のコマンド（コーディングエージェント）には、強める道が無い。
	for _, cmd := range []string{"db-elevate", "db-elevateEnd", "db-elevate-end"} {
		if r := e.do(panecmd.Request{Cmd: cmd, Connection: "shop", Variant: "prod"}); r.OK {
			t.Errorf("%s from a pane: %+v", cmd, r)
		}
	}
	if e.agentMay("prod") {
		t.Error("elevated from a pane")
	}
}

// read-only = true の接続は、強めても「読むだけ」を超えない。
func TestDBElevateReadOnly(t *testing.T) {
	c := elevConn("prod")
	c.ReadOnly = true
	c.Human, c.HumanElevate = elevReader, elevFree
	e := newElevateEnv(t, c)
	if i := e.info("prod"); i.Human.Elevate == nil || i.Human.Elevate.Run != config.DBRunRead {
		t.Errorf("before: %+v", i.Human.Elevate)
	}
	i, err := e.elevate("db.elevate", map[string]any{"connection": "shop", "variant": "prod", "actor": "human", "duration": "1h"})
	if err != nil || i.Human.Permission != "free" || i.Human.Run != config.DBRunRead || !i.ReadOnly {
		t.Errorf("elevated on a read-only connection: %+v, %v", i.Human, err)
	}
}

// 設定が強めた後で書き換わったら：権限の名前か、強めた先（名前か中身）が変われば元に戻し、上限が短くなれば新しい上限までで終える。
func TestDBElevateSettingsChange(t *testing.T) {
	e := newElevateEnv(t, elevConn("prod"))
	elevate := func() {
		t.Helper()
		if _, err := e.elevate("db.elevate", map[string]any{"connection": "shop", "variant": "prod", "actor": "human", "duration": "30m"}); err != nil {
			t.Fatal(err)
		}
	}
	// 強めた先が変わった。
	elevate()
	c := elevConn("prod")
	c.Human.ElevateTo, c.HumanElevate = "free", elevFree
	e.setConns(c)
	if i := e.info("prod"); i.Human.Elevated != nil || i.Human.Permission != "off" {
		t.Errorf("another elevate-to: %+v", i.Human)
	}
	// 元に戻しても、捨てた強めた状態は戻らない。
	e.setConns(elevConn("prod"))
	if e.humanMay("prod") {
		t.Error("the elevation came back with the old settings")
	}
	// 強めた先の名前はそのままで、中身（run）が変わった。
	elevate()
	c = elevConn("prod")
	c.HumanElevate.Run = config.DBRunFree
	e.setConns(c)
	if i := e.info("prod"); i.Human.Elevated != nil || i.Human.Permission != "off" {
		t.Errorf("the target was rewritten: %+v", i.Human)
	}
	e.setConns(elevConn("prod"))
	// 強められなくなった。
	elevate()
	c = elevConn("prod")
	c.Human.ElevateTo, c.Human.ElevateMax, c.HumanElevate = "", 0, config.DBPermission{}
	e.setConns(c)
	if e.humanMay("prod") {
		t.Error("still elevated without elevate-to")
	}
	// 上限が短くなった：強めた時刻から数えて、新しい上限まで。
	e.setConns(elevConn("prod"))
	elevate()
	c = elevConn("prod")
	c.Human.ElevateMax = 5 * time.Minute
	e.setConns(c)
	e.advance(4 * time.Minute)
	if i := e.info("prod"); i.Human.Elevated == nil || i.Human.Elevated.RemainingSeconds != 60 {
		t.Errorf("a shorter elevate-max: %+v", i.Human.Elevated)
	}
	e.advance(time.Minute)
	if e.humanMay("prod") {
		t.Error("elevated past the new elevate-max")
	}
}
