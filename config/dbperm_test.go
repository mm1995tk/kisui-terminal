package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A connection and a variant name the permissions of [db.permissions]; a
// variant takes the ones it does not write from its entry.
func TestLoadDBPermissions(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[db.permissions.all]
run = "free"

[db.permissions.reader]
run = "read"
propose = true
agent-user = "agent_ro"

[db.permissions.off]
run = "none"

[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"
human-permission = "all"
agent-permission = "reader"

[[db.connections.variants]]
name = "local"

[[db.connections.variants]]
name = "prod"
human-permission = "reader"
agent-permission = "off"

[[db.connections]]
name = "plain"
kind = "mysql"
user = "u"
agent-permission = "all"

[[db.connections]]
name = "old"
kind = "mysql"
user = "u"
read-only = true
`), 0o644)
	all := DBPermission{Name: "all", Run: DBRunFree}
	reader := DBPermission{Name: "reader", Run: DBRunRead, Propose: true, AgentUser: "agent_ro"}
	off := DBPermission{Name: "off", Run: DBRunNone}
	got, probs := LoadDB("")
	want := []DBConnection{
		{Name: "shop", Variant: "local", Kind: DBPostgres, Host: "localhost", Port: 5432, User: "app", Human: all, Agent: reader},
		{Name: "shop", Variant: "prod", Kind: DBPostgres, Host: "localhost", Port: 5432, User: "app", Human: reader, Agent: off},
		{Name: "plain", Kind: DBMySQL, Host: "localhost", Port: 3306, User: "u", Agent: all},
		{Name: "old", Kind: DBMySQL, Host: "localhost", Port: 3306, User: "u", ReadOnly: true},
	}
	if len(probs) != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, %v", got, probs)
	}
}

// [db.permissions] of config.local.toml replaces the one of config.toml as
// a whole, apart from the list of connections.
func TestLoadDBPermissionsLocal(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[db.permissions.a]
run = "free"
[db.permissions.b]
run = "free"
[[db.connections]]
name = "x"
kind = "mysql"
user = "u"
agent-permission = "a"
[[db.connections]]
name = "y"
kind = "mysql"
user = "u"
agent-permission = "b"
`), 0o644)
	// No [db.permissions] in the local file: its connections name the
	// permissions of config.toml.
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("[[db.connections]]\nname = \"l\"\nkind = \"mysql\"\nuser = \"u\"\nagent-permission = \"a\"\n"), 0o644)
	got, probs := LoadDB("")
	if len(probs) != 0 || len(got) != 1 || got[0].Name != "l" || got[0].Agent.Run != DBRunFree {
		t.Fatalf("the permissions of config.toml: %+v, %v", got, probs)
	}
	// With one, the permissions of config.toml are gone: `a` is the local
	// one, and the connection that names `b` is a mistake, not a connection
	// with other rights.
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("[db.permissions.a]\nrun = \"read\"\n"), 0o644)
	got, probs = LoadDB("")
	if len(got) != 1 || got[0].Name != "x" || got[0].Agent.Run != DBRunRead {
		t.Errorf("the local permissions: %+v", got)
	}
	if len(probs) != 1 || probs[0].Key != "db.connections[1].agent-permission" || probs[0].Code != "config.err.noperm" || !strings.HasSuffix(probs[0].File, "config.toml") {
		t.Errorf("problems: %+v", probs)
	}
}

// A mistake in a permission leaves out the connections that name it: a
// connection never runs with other rights than its settings show.
func TestLoadDBPermissionMistakes(t *testing.T) {
	dir := userDir(t)
	const conns = "[[db.connections]]\nname = \"ok\"\nkind = \"postgres\"\nuser = \"u\"\n[[db.connections]]\nname = \"x\"\nkind = \"mysql\"\nuser = \"u\"\n"
	load := func(body string) ([]DBConnection, []Problem, string) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(body), 0o644)
		got, probs := LoadDB("")
		var texts []string
		for _, p := range probs {
			texts = append(texts, p.Text())
		}
		return got, probs, strings.Join(texts, "\n")
	}
	// A mistake in a permission: reported once for the permission and once
	// for the connection that names it.
	for name, c := range map[string]struct{ perm, key string }{
		"no run":       {"propose = true\n", "db.permissions.p.run"},
		"unknown run":  {"run = \"write\"\n", "db.permissions.p.run"},
		"run type":     {"run = true\n", "db.permissions.p.run"},
		"propose type": {"run = \"read\"\npropose = \"yes\"\n", "db.permissions.p.propose"},
		"empty user":   {"run = \"read\"\nagent-user = \"\"\n", "db.permissions.p.agent-user"},
		"misspelt key": {"run = \"read\"\nagent_user = \"a\"\n", "db.permissions.p.agent_user"},
	} {
		got, probs, text := load("[db.permissions.p]\n" + c.perm + conns + "agent-permission = \"p\"\n")
		if len(got) != 1 || got[0].Name != "ok" || len(probs) != 2 || !strings.Contains(text, c.key+": ") ||
			probs[1].Key != "db.connections[1].agent-permission" || probs[1].Code != "config.err.brokenperm" {
			t.Errorf("%s: connections %+v, problems %q", name, got, text)
		}
	}
	// A mistake in the key of a connection or of a variant.
	for name, c := range map[string]struct{ body, key string }{
		"no such permission": {"human-permission = \"nobody\"\n", "db.connections[1].human-permission"},
		"not a string":       {"agent-permission = 1\n", "db.connections[1].agent-permission"},
		"empty":              {"agent-permission = \"\"\n", "db.connections[1].agent-permission"},
		"in a variant":       {"[[db.connections.variants]]\nname = \"a\"\n[[db.connections.variants]]\nname = \"b\"\nagent-permission = \"nobody\"\n", "db.connections[1].variants[1].agent-permission"},
		"misspelt key":       {"agent-permision = \"p\"\n", "db.connections[1].agent-permision"},
	} {
		got, probs, text := load("[db.permissions.p]\nrun = \"read\"\n" + conns + c.body)
		if len(got) != 1 || got[0].Name != "ok" || len(probs) != 1 || !strings.Contains(text, c.key+": ") {
			t.Errorf("%s: connections %+v, problems %q", name, got, text)
		}
	}
	// Not a table.
	got, probs, _ := load("[db]\npermissions = 1\n" + conns + "agent-permission = \"p\"\n")
	if len(got) != 1 || len(probs) != 2 || probs[0].Key != "db.permissions" || probs[1].Code != "config.err.noperm" {
		t.Errorf("permissions = 1: %+v, %+v", got, probs)
	}
	got, probs, _ = load("[db.permissions]\np = 1\n" + conns)
	if len(got) != 2 || len(probs) != 1 || probs[0].Key != "db.permissions.p" {
		t.Errorf("a permission that is no table: %+v, %+v", got, probs)
	}
}

// Access is the one place that decides what somebody may do.
func TestDBAccess(t *testing.T) {
	free := DBPermission{Name: "free", Run: DBRunFree, Propose: true, AgentUser: "bot"}
	read := DBPermission{Name: "read", Run: DBRunRead}
	none := DBPermission{Name: "none", Run: DBRunNone, Propose: true}
	sameUser := DBPermission{Name: "same", Run: DBRunRead, AgentUser: "app"}
	for name, c := range map[string]struct {
		conn  DBConnection
		actor DBActor
		want  DBAccess
	}{
		// Nothing written: a person does what read-only says, an agent
		// runs nothing and may write into the input.
		"human, nothing":   {DBConnection{User: "app"}, DBHuman, DBAccess{Actor: DBHuman, Run: DBRunFree, User: "app"}},
		"human, read-only": {DBConnection{User: "app", ReadOnly: true}, DBHuman, DBAccess{Actor: DBHuman, Run: DBRunRead, User: "app"}},
		"agent, nothing":   {DBConnection{User: "app"}, DBAgent, DBAccess{Actor: DBAgent, Run: DBRunNone, Propose: true, User: "app"}},
		"agent, read-only": {DBConnection{User: "app", ReadOnly: true}, DBAgent, DBAccess{Actor: DBAgent, Run: DBRunNone, Propose: true, User: "app"}},
		// A permission.
		"human, read": {DBConnection{User: "app", Human: read}, DBHuman, DBAccess{Actor: DBHuman, Permission: "read", Run: DBRunRead, User: "app"}},
		"human, none": {DBConnection{User: "app", Human: none}, DBHuman, DBAccess{Actor: DBHuman, Permission: "none", Run: DBRunNone, User: "app"}},
		// What a permission says for an agent says nothing for a person.
		"human, free": {DBConnection{User: "app", Human: free}, DBHuman, DBAccess{Actor: DBHuman, Permission: "free", Run: DBRunFree, User: "app"}},
		"agent, free": {DBConnection{User: "app", Agent: free}, DBAgent, DBAccess{Actor: DBAgent, Permission: "free", Run: DBRunFree, Propose: true, User: "bot", AgentUser: true}},
		"agent, read": {DBConnection{User: "app", Agent: read}, DBAgent, DBAccess{Actor: DBAgent, Permission: "read", Run: DBRunRead, User: "app"}},
		"agent, none": {DBConnection{User: "app", Agent: none}, DBAgent, DBAccess{Actor: DBAgent, Permission: "none", Run: DBRunNone, Propose: true, User: "app"}},
		// An agent-user that is the user of the connection is not a user
		// of the agent's own.
		"agent, same user": {DBConnection{User: "app", Agent: sameUser}, DBAgent, DBAccess{Actor: DBAgent, Permission: "same", Run: DBRunRead, User: "app"}},
		// The permission of one says nothing for the other.
		"human beside an agent": {DBConnection{User: "app", Agent: free}, DBHuman, DBAccess{Actor: DBHuman, Run: DBRunFree, User: "app"}},
		"agent beside a human":  {DBConnection{User: "app", Human: free}, DBAgent, DBAccess{Actor: DBAgent, Run: DBRunNone, Propose: true, User: "app"}},
		// read-only = true holds for everybody: a permission cannot make
		// the connection writable.
		"human, free, read-only": {DBConnection{User: "app", ReadOnly: true, Human: free}, DBHuman, DBAccess{Actor: DBHuman, Permission: "free", Run: DBRunRead, User: "app"}},
		"agent, free, read-only": {DBConnection{User: "app", ReadOnly: true, Agent: free}, DBAgent, DBAccess{Actor: DBAgent, Permission: "free", Run: DBRunRead, Propose: true, User: "bot", AgentUser: true}},
		"human, none, read-only": {DBConnection{User: "app", ReadOnly: true, Human: none}, DBHuman, DBAccess{Actor: DBHuman, Permission: "none", Run: DBRunNone, User: "app"}},
		// Nobody we know.
		"unknown actor": {DBConnection{User: "app", Human: free, Agent: free}, DBActor("robot"), DBAccess{Actor: "robot", Run: DBRunNone, User: "app"}},
	} {
		if got := c.conn.Access(c.actor); got != c.want {
			t.Errorf("%s:\n got %+v\nwant %+v", name, got, c.want)
		}
	}
}

// Login is the connection as somebody logs in: their user, and read-only
// unless they may run freely.
func TestDBLogin(t *testing.T) {
	conn := DBConnection{Name: "shop", Variant: "prod", Kind: DBPostgres, Host: "h", Port: 5432, User: "app", Database: "d",
		Agent: DBPermission{Name: "p", Run: DBRunRead, AgentUser: "bot"}}
	got := conn.Login(conn.Access(DBAgent))
	want := conn
	want.User, want.AgentLogin, want.ReadOnly = "bot", true, true
	if got != want {
		t.Errorf("agent: %+v", got)
	}
	if got := conn.Login(conn.Access(DBHuman)); got != conn {
		t.Errorf("human: %+v", got)
	}
	// The agent's own user opens the database of the connection's user:
	// PostgreSQL would otherwise open the one named like the agent's user.
	noDB := conn
	noDB.Database = ""
	if got := noDB.Login(noDB.Access(DBAgent)); got.Database != "app" || got.User != "bot" {
		t.Errorf("agent, postgres without a database: %+v", got)
	}
	if got := noDB.Login(noDB.Access(DBHuman)); got != noDB {
		t.Errorf("human, postgres without a database: %+v", got)
	}
	noDB.Kind = DBMySQL
	if got := noDB.Login(noDB.Access(DBAgent)); got.Database != "" {
		t.Errorf("agent, mysql without a database: %+v", got)
	}
	// A level that runs nothing still logs in read-only (to list the schema).
	conn.Agent = DBPermission{}
	if got := conn.Login(conn.Access(DBAgent)); !got.ReadOnly || got.User != "app" || got.AgentLogin {
		t.Errorf("agent with no permission: %+v", got)
	}
	conn.Agent = DBPermission{Name: "f", Run: DBRunFree}
	if got := conn.Login(conn.Access(DBAgent)); got.ReadOnly {
		t.Errorf("a free agent logs in read-only: %+v", got)
	}
}
