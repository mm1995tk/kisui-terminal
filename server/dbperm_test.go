package server

import (
	"context"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
	"github.com/mm1995tk/kisui-terminal/internal/db/dbtest"
	"github.com/mm1995tk/kisui-terminal/rpc"
)

// dbCurrentUser は、ログインしているユーザーを聞く SQL（PostgreSQL は名前、MySQL は「名前@ホスト」を返す）。
const dbCurrentUser = "SELECT CURRENT_USER"

// 人の権限：「読むだけ」は DB が書き込みを断り、「しない」は DB につながずに denied、「自由」は書ける。
// 権限を書いていない接続は、今までどおり read-only に従う。read-only = true は、権限が「自由」でも書けない。
func TestDBHumanPermission(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		free := config.DBPermission{Name: "free", Run: config.DBRunFree}
		variant := func(name string, human config.DBPermission, readOnly bool) config.DBConnection {
			c := conn
			c.Variant, c.Human, c.ReadOnly = name, human, readOnly
			return c
		}
		c := dbServer(t, nil,
			variant("plain", config.DBPermission{}, false),
			variant("free", free, false),
			variant("read", config.DBPermission{Name: "r", Run: config.DBRunRead}, false),
			variant("none", config.DBPermission{Name: "n", Run: config.DBRunNone}, false),
			variant("guarded", free, true),
		)
		ctx := context.Background()
		query := func(variant, sql string) (dbResult, error) {
			var res dbResult
			err := c.Call(ctx, "db.query", map[string]any{"connection": conn.Name, "variant": variant, "sql": sql, "password": dbtest.Password, "actor": "human"}, &res)
			return res, err
		}
		table := "t_server_human_perm"
		for _, sql := range []string{"DROP TABLE IF EXISTS " + table, "CREATE TABLE " + table + " (id INT)", "INSERT INTO " + table + " VALUES (1)"} {
			if _, err := query("plain", sql); err != nil {
				t.Fatalf("%s: %v", sql, err)
			}
		}
		if res, err := query("free", "UPDATE "+table+" SET id = 2"); err != nil || res.RowsAffected == nil || *res.RowsAffected != 1 {
			t.Errorf("free: UPDATE: %+v, %v", res, err)
		}
		for _, v := range []string{"read", "guarded"} {
			_, err := query(v, "UPDATE "+table+" SET id = 3")
			if code, data := dbErr(t, err); code != rpc.CodeDBError || data["kind"] != "query" || data["sqlState"] != "25006" {
				t.Errorf("%s: UPDATE: %v", v, err)
			}
			if res, err := query(v, "SELECT id FROM "+table); err != nil || len(res.Rows) != 1 || *res.Rows[0][0] != "2" {
				t.Errorf("%s: SELECT: %+v, %v", v, res, err)
			}
		}
		_, err := query("none", "SELECT 1")
		if code, data := dbErr(t, err); code != rpc.CodeDenied || data["actor"] != "human" || data["permission"] != "n" {
			t.Errorf("none: SELECT: %v", err)
		}
		// スキーマの一覧は、実行の段階に関わらず読める。
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name, "variant": "none", "password": dbtest.Password}, nil); err != nil {
			t.Errorf("none: db.schema: %v", err)
		}
		// 一覧は、権限を合わせた結果を返す。readOnly は、人の実行が「読むだけ」か。
		var list DBConnectionsResult
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		for _, info := range list.Connections {
			want := map[string]DBHumanAccess{
				"plain":   {Run: config.DBRunFree},
				"free":    {Permission: "free", Run: config.DBRunFree},
				"read":    {Permission: "r", Run: config.DBRunRead},
				"none":    {Permission: "n", Run: config.DBRunNone},
				"guarded": {Permission: "free", Run: config.DBRunRead},
			}[info.Variant]
			if info.Human != want || info.ReadOnly != (want.Run == config.DBRunRead) {
				t.Errorf("db.connections, %s: %+v, readOnly %v", info.Variant, info.Human, info.ReadOnly)
			}
		}
	})
}

// エージェントの要求（actor が "agent"）は、エージェントの権限に従う。権限を書いていない接続では実行できず、
// スキーマの一覧は読める。人の権限とは別で、人が自由でもエージェントは強くならない。
func TestDBAgentPermission(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		variant := func(name string, agent config.DBPermission, readOnly bool) config.DBConnection {
			c := conn
			c.Variant, c.Agent, c.ReadOnly = name, agent, readOnly
			c.Human = config.DBPermission{Name: "h", Run: config.DBRunFree}
			return c
		}
		free := config.DBPermission{Name: "free", Run: config.DBRunFree, Propose: true}
		dir := t.TempDir()
		c := dbServerAt(t, dir,
			variant("plain", config.DBPermission{}, false),
			variant("free", free, false),
			variant("read", config.DBPermission{Name: "r", Run: config.DBRunRead}, false),
			variant("none", config.DBPermission{Name: "n", Run: config.DBRunNone}, false),
			variant("guarded", free, true),
		)
		ctx := context.Background()
		call := func(method, actor, variant, sql string) (dbResult, error) {
			var res dbResult
			p := map[string]any{"connection": conn.Name, "variant": variant, "password": dbtest.Password}
			if actor != "" {
				p["actor"] = actor
			}
			if method == "db.query" {
				p["sql"] = sql
				return res, c.Call(ctx, method, p, &res)
			}
			return res, c.Call(ctx, method, p, nil)
		}
		table := "t_server_agent_perm"
		// 窓（actor 無し）は人。
		for _, sql := range []string{"DROP TABLE IF EXISTS " + table, "CREATE TABLE " + table + " (id INT)", "INSERT INTO " + table + " VALUES (1)"} {
			if _, err := call("db.query", "", "plain", sql); err != nil {
				t.Fatalf("%s: %v", sql, err)
			}
		}
		for v, permission := range map[string]string{"plain": "", "none": "n"} {
			_, err := call("db.query", "agent", v, "SELECT 1")
			if code, data := dbErr(t, err); code != rpc.CodeDenied || data["actor"] != "agent" || data["permission"] != permission {
				t.Errorf("%s: SELECT as the agent: %v", v, err)
			}
			if _, err := call("db.schema", "agent", v, ""); err != nil {
				t.Errorf("%s: db.schema as the agent: %v", v, err)
			}
		}
		for _, v := range []string{"read", "guarded"} {
			_, err := call("db.query", "agent", v, "UPDATE "+table+" SET id = 3")
			if code, data := dbErr(t, err); code != rpc.CodeDBError || data["sqlState"] != "25006" {
				t.Errorf("%s: UPDATE as the agent: %v", v, err)
			}
			if res, err := call("db.query", "agent", v, "SELECT id FROM "+table); err != nil || len(res.Rows) != 1 || *res.Rows[0][0] != "1" {
				t.Errorf("%s: SELECT as the agent: %+v, %v", v, res, err)
			}
		}
		if res, err := call("db.query", "agent", "free", "UPDATE "+table+" SET id = 2"); err != nil || res.RowsAffected == nil || *res.RowsAffected != 1 {
			t.Errorf("free: UPDATE as the agent: %+v, %v", res, err)
		}
		// 知らない actor は、人として通さない。
		for _, method := range []string{"db.query", "db.schema"} {
			_, err := call(method, "robot", "free", "SELECT 1")
			if e, ok := err.(*rpc.Error); !ok || e.Code != rpc.CodeInvalidParams {
				t.Errorf("%s with an unknown actor: %v", method, err)
			}
		}
		// 一覧は、エージェントにしてよいことも返す。
		var list DBConnectionsResult
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		for _, info := range list.Connections {
			want := map[string]DBAgentAccess{
				"plain":   {Run: config.DBRunNone, Propose: true, User: conn.User},
				"free":    {Permission: "free", Run: config.DBRunFree, Propose: true, User: conn.User},
				"read":    {Permission: "r", Run: config.DBRunRead, User: conn.User},
				"none":    {Permission: "n", Run: config.DBRunNone, User: conn.User},
				"guarded": {Permission: "free", Run: config.DBRunRead, Propose: true, User: conn.User},
			}[info.Variant]
			if info.Agent != want {
				t.Errorf("db.connections, %s: %+v", info.Variant, info.Agent)
			}
		}
	})
}

// 権限に agent-user があれば、エージェントの要求はそのユーザーでログインする。パスワードはそのユーザーのもので、
// 人のユーザーで通ったパスワードは使わない。人の要求は、接続のユーザーのまま。
func TestDBAgentUser(t *testing.T) {
	bothDB(t, func(t *testing.T, conn config.DBConnection) {
		ctx := context.Background()
		// エージェント用のユーザー。PostgreSQL は作る。MySQL は、テスト用のサーバーにある、パスワードの無い root を使う。
		agentUser, agentPassword := "root", ""
		if conn.Kind == config.DBPostgres {
			agentUser, agentPassword = "kisui_agent", "agent pass"
		}
		withAgent := conn
		withAgent.Variant = "a"
		withAgent.Agent = config.DBPermission{Name: "bot", Run: config.DBRunRead, AgentUser: agentUser}
		conn.Variant = "setup"
		c := dbServer(t, nil, conn, withAgent)
		query := func(variant, actor string, password *string, sql string) (dbResult, error) {
			var res dbResult
			p := map[string]any{"connection": conn.Name, "variant": variant, "sql": sql, "actor": actor}
			if password != nil {
				p["password"] = *password
			}
			return res, c.Call(ctx, "db.query", p, &res)
		}
		humanPassword := dbtest.Password
		if conn.Kind == config.DBPostgres {
			for _, sql := range []string{"DROP ROLE IF EXISTS kisui_agent", "CREATE ROLE kisui_agent LOGIN PASSWORD 'agent pass'"} {
				if _, err := query("setup", "human", &humanPassword, sql); err != nil {
					t.Fatalf("%s: %v", sql, err)
				}
			}
		}
		user := func(res dbResult) string {
			if len(res.Rows) != 1 || res.Rows[0][0] == nil {
				return ""
			}
			name, _, _ := strings.Cut(*res.Rows[0][0], "@")
			return name
		}
		// 人は接続のユーザーでログインし、通ったパスワードを覚える。
		if res, err := query("a", "human", &humanPassword, dbCurrentUser); err != nil || user(res) != conn.User {
			t.Fatalf("the human: %+v, %v", res, err)
		}
		// エージェントのユーザーのパスワードは、まだどこにも無い：人のユーザーのものは使わない。
		_, err := query("a", "agent", nil, dbCurrentUser)
		if code, data := dbErr(t, err); code != rpc.CodePasswordRequired || data["reason"] != "missing" {
			t.Fatalf("the agent without a password: %v", err)
		}
		res, err := query("a", "agent", &agentPassword, dbCurrentUser)
		if err != nil || user(res) != agentUser {
			t.Fatalf("the agent: %+v, %v", res, err)
		}
		// 通ったパスワードは、エージェントのユーザーの分として覚える。人の分はそのまま。
		if res, err := query("a", "agent", nil, dbCurrentUser); err != nil || user(res) != agentUser {
			t.Errorf("the agent, remembered: %+v, %v", res, err)
		}
		if res, err := query("a", "human", nil, dbCurrentUser); err != nil || user(res) != conn.User {
			t.Errorf("the human, remembered: %+v, %v", res, err)
		}
		// スキーマの一覧も、エージェントのユーザーで読む。
		if err := c.Call(ctx, "db.schema", map[string]any{"connection": conn.Name, "variant": "a", "actor": "agent"}, nil); err != nil {
			t.Errorf("db.schema as the agent: %v", err)
		}
		// 一覧は、エージェントのユーザーを返す。
		var list DBConnectionsResult
		if err := c.Call(ctx, "db.connections", struct{}{}, &list); err != nil {
			t.Fatal(err)
		}
		if got := list.Connections[1]; got.Agent.User != agentUser || got.User != conn.User {
			t.Errorf("db.connections: %+v", got)
		}
	})
}
