package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `elevate-to` and `elevate-max` of a permission say what it can be
// strengthened to, and for how long at a time. A connection carries the
// permission it is strengthened to, a variant too.
func TestLoadDBElevate(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[db.permissions.free]
run = "free"

[db.permissions.reader]
run = "read"
elevate-to = "free"
elevate-max = "30m"

[db.permissions.off]
run = "none"
propose = true
elevate-to = "reader"
elevate-max = "1h30m"

[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"
human-permission = "reader"

[[db.connections.variants]]
name = "local"
human-permission = "free"

[[db.connections.variants]]
name = "prod"
agent-permission = "off"
`), 0o644)
	got, probs := LoadDB("")
	if len(probs) != 0 || len(got) != 2 {
		t.Fatalf("got %+v, %v", got, probs)
	}
	local, prod := got[0], got[1]
	// The variant that names another permission does not keep the target of
	// the permission of its entry.
	if local.Human.Name != "free" || local.HumanElevate.Name != "" {
		t.Errorf("local: %+v", local)
	}
	if _, ok := local.ElevateTarget(DBHuman); ok {
		t.Error("local: a permission without elevate-to can be elevated")
	}
	if prod.Human.ElevateTo != "free" || prod.Human.ElevateMax != 30*time.Minute || prod.HumanElevate.Run != DBRunFree {
		t.Errorf("prod, human: %+v", prod)
	}
	if prod.Agent.ElevateMax != 90*time.Minute || prod.AgentElevate.Name != "reader" {
		t.Errorf("prod, agent: %+v", prod)
	}
}

// A mistake in `elevate-to` or `elevate-max` makes the permission one with a
// mistake: the connections that name it are left out.
func TestLoadDBElevateMistakes(t *testing.T) {
	dir := userDir(t)
	const conns = "[[db.connections]]\nname = \"ok\"\nkind = \"postgres\"\nuser = \"u\"\n[[db.connections]]\nname = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nhuman-permission = \"p\"\n"
	for name, c := range map[string]struct{ perm, key, code string }{
		"no such permission": {"elevate-to = \"nobody\"\nelevate-max = \"30m\"\n", "db.permissions.p.elevate-to", "config.err.noperm"},
		"itself":             {"elevate-to = \"p\"\nelevate-max = \"30m\"\n", "db.permissions.p.elevate-to", "config.err.elevateself"},
		"a broken one":       {"elevate-to = \"broken\"\nelevate-max = \"30m\"\n[db.permissions.broken]\nrun = \"write\"\n", "db.permissions.p.elevate-to", "config.err.brokenperm"},
		"no max":             {"elevate-to = \"free\"\n", "db.permissions.p.elevate-max", "config.err.elevatepair"},
		"no target":          {"elevate-max = \"30m\"\n", "db.permissions.p.elevate-to", "config.err.elevatepair"},
		"a number":           {"elevate-to = \"free\"\nelevate-max = 30\n", "db.permissions.p.elevate-max", "config.err.string"},
		"no unit":            {"elevate-to = \"free\"\nelevate-max = \"30\"\n", "db.permissions.p.elevate-max", "config.err.duration"},
		"zero":               {"elevate-to = \"free\"\nelevate-max = \"0m\"\n", "db.permissions.p.elevate-max", "config.err.duration"},
	} {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[db.permissions.free]\nrun = \"free\"\n[db.permissions.p]\nrun = \"read\"\n"+c.perm+conns), 0o644)
		got, probs := LoadDB("")
		found := false
		for _, p := range probs {
			found = found || (p.Key == c.key && p.Code == c.code)
		}
		last := Problem{}
		if len(probs) > 0 {
			last = probs[len(probs)-1]
		}
		if len(got) != 1 || got[0].Name != "ok" || !found || last.Key != "db.connections[1].human-permission" || last.Code != "config.err.brokenperm" {
			t.Errorf("%s: connections %+v, problems %+v", name, got, probs)
		}
		for _, p := range probs {
			if strings.Contains(p.Text(), "config.err.") {
				t.Errorf("%s: a problem without a text: %s", name, p.Text())
			}
		}
	}
	// A permission that names one that names a mistake is a mistake too.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[db.permissions.a]\nrun = \"none\"\nelevate-to = \"p\"\nelevate-max = \"1h\"\n[db.permissions.p]\nrun = \"read\"\nelevate-to = \"nobody\"\nelevate-max = \"1h\"\n"+strings.Replace(conns, "\"p\"", "\"a\"", 1)), 0o644)
	got, probs := LoadDB("")
	if len(got) != 1 || len(probs) != 3 {
		t.Errorf("a chain: connections %+v, problems %+v", got, probs)
	}
}

func TestParseDBDuration(t *testing.T) {
	for s, want := range map[string]time.Duration{
		"30m": 30 * time.Minute, "1h": time.Hour, "1h30m": 90 * time.Minute, "90s": 90 * time.Second, "2h0m5s": 2*time.Hour + 5*time.Second, "1h5s": time.Hour + 5*time.Second, "999999h999999m999999s": 999999 * (time.Hour + time.Minute + time.Second),
	} {
		if got, ok := ParseDBDuration(s); !ok || got != want {
			t.Errorf("%q: %v, %v", s, got, ok)
		}
	}
	for _, s := range []string{"", "30", "m", "1.5h", "-5m", "5 m", "5d", "0m", "0h0s", "30M", "1h30", "1234567h", "1h1h", "30m1h", "5s5m", "999999h999999h999999h999999h999999h999999h", "３０m"} {
		if got, ok := ParseDBDuration(s); ok {
			t.Errorf("%q: %v", s, got)
		}
	}
}

// Elevated replaces the permission of one actor with the one it is
// strengthened to. read-only = true still holds, and the result cannot be
// strengthened again.
func TestDBElevated(t *testing.T) {
	free := DBPermission{Name: "free", Run: DBRunFree, Propose: true, AgentUser: "bot", ElevateTo: "more", ElevateMax: time.Hour}
	read := DBPermission{Name: "read", Run: DBRunRead, ElevateTo: "free", ElevateMax: 30 * time.Minute}
	c := DBConnection{User: "app", Human: read, HumanElevate: free, Agent: DBPermission{Name: "off", Run: DBRunNone}}
	e, ok := c.Elevated(DBHuman)
	if a := e.Access(DBHuman); !ok || a.Permission != "free" || a.Run != DBRunFree {
		t.Errorf("human: %+v, %v", a, ok)
	}
	if _, again := e.Elevated(DBHuman); again || e.Human.ElevateTo != "" {
		t.Errorf("elevated twice: %+v", e)
	}
	// The agent's permission is not touched, and cannot be strengthened.
	if a := e.Access(DBAgent); a.Run != DBRunNone {
		t.Errorf("agent beside an elevated human: %+v", a)
	}
	if got, ok := c.Elevated(DBAgent); ok || got != c {
		t.Errorf("an agent without elevate-to: %+v, %v", got, ok)
	}
	// An agent takes the user of the permission it is strengthened to.
	c = DBConnection{User: "app", Agent: read, AgentElevate: free}
	e, _ = c.Elevated(DBAgent)
	if a := e.Access(DBAgent); a.Run != DBRunFree || a.User != "bot" || !a.AgentUser || !a.Propose {
		t.Errorf("agent: %+v", a)
	}
	// read-only = true wins over a time of strengthening too.
	c = DBConnection{User: "app", ReadOnly: true, Human: read, HumanElevate: free}
	e, _ = c.Elevated(DBHuman)
	if a := e.Access(DBHuman); a.Permission != "free" || a.Run != DBRunRead {
		t.Errorf("read-only: %+v", a)
	}
	if _, ok := c.Elevated(DBActor("robot")); ok {
		t.Error("an unknown actor can be elevated")
	}
}
