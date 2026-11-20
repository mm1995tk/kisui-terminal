package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadDB(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[server]
idle_stop_days = 1

[[db.connections]]
name = "dev"
kind = "postgres"
user = "app"

[[db.connections]]
name = "prod"
kind = "mysql"
host = "db.example.com"
port = 3307
user = "reader"
database = "shop"
read-only = true
`), 0o644)
	got, probs := LoadDB("")
	want := []DBConnection{
		{Name: "dev", Kind: DBPostgres, Host: "localhost", Port: 5432, User: "app"},
		{Name: "prod", Kind: DBMySQL, Host: "db.example.com", Port: 3307, User: "reader", Database: "shop", ReadOnly: true},
	}
	if len(probs) != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, %v", got, probs)
	}
	// The defaults of MySQL.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("db.connections = [{name = \"m\", kind = \"mysql\", user = \"u\"}]\n"), 0o644)
	got, probs = LoadDB("")
	if len(probs) != 0 || len(got) != 1 || got[0].Port != 3306 || got[0].Host != "localhost" {
		t.Fatalf("got %+v, %v", got, probs)
	}
}

func TestLoadDBNothing(t *testing.T) {
	dir := userDir(t)
	if got, probs := LoadDB(""); len(got) != 0 || len(probs) != 0 {
		t.Fatalf("no file: %+v, %v", got, probs)
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[db]\nconnections = []\n"), 0o644)
	if got, probs := LoadDB(""); len(got) != 0 || len(probs) != 0 {
		t.Fatalf("an empty list: %+v, %v", got, probs)
	}
}

// The list of config.local.toml replaces the list of config.toml as a whole,
// and takes the mistakes of the replaced list away.
func TestLoadDBLocalReplaces(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[[db.connections]]\nname = \"a\"\nkind = \"postgres\"\nuser = \"u\"\n[[db.connections]]\nname = \"broken\"\n"), 0o644)
	if got, probs := LoadDB(""); len(got) != 1 || len(probs) == 0 {
		t.Fatalf("before: %+v, %v", got, probs)
	}
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("[[db.connections]]\nname = \"b\"\nkind = \"mysql\"\nuser = \"u\"\n"), 0o644)
	got, probs := LoadDB("")
	if len(probs) != 0 || len(got) != 1 || got[0].Name != "b" {
		t.Fatalf("got %+v, %v", got, probs)
	}
	// A local file without a list leaves the list of config.toml.
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("ui-language = \"ja\"\n"), 0o644)
	if got, _ := LoadDB(""); len(got) != 1 || got[0].Name != "a" {
		t.Fatalf("got %+v", got)
	}
}

// An entry with a mistake is left out and reported; the others stay.
func TestLoadDBMistakes(t *testing.T) {
	dir := userDir(t)
	entry := func(body string) (int, string) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[[db.connections]]\nname = \"ok\"\nkind = \"postgres\"\nuser = \"u\"\n[[db.connections]]\n"+body), 0o644)
		got, probs := LoadDB("")
		var texts []string
		for _, p := range probs {
			texts = append(texts, p.Text())
		}
		return len(got), strings.Join(texts, "\n")
	}
	for name, c := range map[string]struct{ body, key string }{
		"no name":       {"kind = \"mysql\"\nuser = \"u\"\n", "db.connections[1].name"},
		"empty name":    {"name = \" \"\nkind = \"mysql\"\nuser = \"u\"\n", "db.connections[1].name"},
		"same name":     {"name = \"ok\"\nkind = \"mysql\"\nuser = \"u\"\n", "db.connections[1].name"},
		"unknown kind":  {"name = \"x\"\nkind = \"sqlite\"\nuser = \"u\"\n", "db.connections[1].kind"},
		"no user":       {"name = \"x\"\nkind = \"mysql\"\n", "db.connections[1].user"},
		"port range":    {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nport = 70000\n", "db.connections[1].port"},
		"port type":     {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nport = \"3306\"\n", "db.connections[1].port"},
		"read-only":     {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nread-only = \"yes\"\n", "db.connections[1].read-only"},
		"password":      {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\npassword = \"secret\"\n", "db.connections[1].password"},
		"control chars": {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nhost = \"a\\nb\"\n", "db.connections[1].host"},
		"misspelt key":  {"name = \"x\"\nkind = \"mysql\"\nuser = \"u\"\nreadonly = true\n", "db.connections[1].readonly"},
	} {
		n, text := entry(c.body)
		if n != 1 || !strings.Contains(text, c.key+": ") {
			t.Errorf("%s: %d connections, problems %q", name, n, text)
		}
		if strings.Contains(text, "secret") {
			t.Errorf("%s: the problem shows the password: %q", name, text)
		}
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[db]\nconnections = 1\n"), 0o644)
	if got, probs := LoadDB(""); len(got) != 0 || len(probs) != 1 || probs[0].Key != "db.connections" {
		t.Errorf("not a list: %+v, %v", got, probs)
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("db = 1\n"), 0o644)
	if got, probs := LoadDB(""); len(got) != 0 || len(probs) != 1 || probs[0].Key != "db" {
		t.Errorf("not a table: %+v, %v", got, probs)
	}
	// Load, which runs at startup, does not look at [db]: a mistake here must
	// not keep kisui serve from starting.
	if _, err := Load(""); err != nil {
		t.Errorf("Load failed on a mistake in db: %v", err)
	}
}
