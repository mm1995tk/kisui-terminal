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
		{Name: "dev", Kind: DBPostgres, Host: "localhost", Port: 5432, User: "app", TLS: DBTLSPrefer},
		{Name: "prod", Kind: DBMySQL, Host: "db.example.com", Port: 3307, User: "reader", Database: "shop", ReadOnly: true, TLS: DBTLSPrefer},
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

// dbNames are the labels of the connections, each with "+" when it is from
// config.local.toml.
func dbNames(list []DBConnection) string {
	var out []string
	for _, c := range list {
		l := c.Label()
		if c.Local {
			l += "+"
		}
		out = append(out, l)
	}
	return strings.Join(out, " ")
}

// The lists of the two files are merged by name: an entry of
// config.local.toml takes the place of the one of config.toml with its name,
// and the entries only one file has stay.
func TestLoadDBLocalMergesByName(t *testing.T) {
	dir := userDir(t)
	base := filepath.Join(dir, "config.toml")
	local := filepath.Join(dir, "config.local.toml")
	entry := func(name, rest string) string {
		return "[[db.connections]]\nname = \"" + name + "\"\nkind = \"postgres\"\nuser = \"u\"\n" + rest
	}
	os.WriteFile(base, []byte(entry("a", "")+entry("b", "port = 1\n")+entry("c", "")), 0o644)
	os.WriteFile(local, []byte(entry("d", "")+entry("b", "port = 2\n")), 0o644)
	got, probs := LoadDB("")
	// The order of config.toml, with b replaced where it was, then d.
	if len(probs) != 0 || dbNames(got) != "a b+ c d+" || got[1].Port != 2 {
		t.Fatalf("got %s (%+v), %v", dbNames(got), got, probs)
	}
	// The whole entry is replaced: a key only the entry of config.toml has
	// is not taken over.
	os.WriteFile(local, []byte(entry("b", "")), 0o644)
	if got, _ := LoadDB(""); dbNames(got) != "a b+ c" || got[1].Port != 5432 {
		t.Fatalf("got %s (%+v)", dbNames(got), got)
	}
	// An entry with variants is replaced with all of them.
	os.WriteFile(base, []byte(entry("a", "[[db.connections.variants]]\nname = \"dev\"\n[[db.connections.variants]]\nname = \"prod\"\n")+entry("c", "")), 0o644)
	os.WriteFile(local, []byte(entry("a", "[[db.connections.variants]]\nname = \"local\"\n")), 0o644)
	if got, probs := LoadDB(""); len(probs) != 0 || dbNames(got) != "a (local)+ c" {
		t.Fatalf("got %s, %v", dbNames(got), probs)
	}
	// A local file without a list, or with an empty one, leaves the list of
	// config.toml: an empty list takes nothing away.
	for _, text := range []string{"ui-language = \"ja\"\n", "[db]\nconnections = []\n"} {
		os.WriteFile(local, []byte(text), 0o644)
		if got, probs := LoadDB(""); len(probs) != 0 || dbNames(got) != "a (dev) a (prod) c" {
			t.Fatalf("%q: got %s, %v", text, dbNames(got), probs)
		}
	}
	// config.local.toml alone.
	os.Remove(base)
	os.WriteFile(local, []byte(entry("z", "")), 0o644)
	if got, probs := LoadDB(""); len(probs) != 0 || dbNames(got) != "z+" {
		t.Fatalf("got %s, %v", dbNames(got), probs)
	}
}

// The mistakes of an entry go away with it when it is replaced, and an entry
// of config.local.toml with a mistake still takes away the one of config.toml
// it has the name of.
func TestLoadDBLocalMergeMistakes(t *testing.T) {
	dir := userDir(t)
	base := filepath.Join(dir, "config.toml")
	local := filepath.Join(dir, "config.local.toml")
	ok := func(name string) string {
		return "[[db.connections]]\nname = \"" + name + "\"\nkind = \"postgres\"\nuser = \"u\"\n"
	}
	broken := func(name string) string { return "[[db.connections]]\nname = \"" + name + "\"\n" }
	keys := func(probs []Problem) string {
		var out []string
		for _, p := range probs {
			out = append(out, filepath.Base(p.File)+":"+p.Key)
		}
		return strings.Join(out, " ")
	}
	// A mistake in an entry of config.toml that is not replaced stays.
	os.WriteFile(base, []byte(ok("a")+broken("b")), 0o644)
	os.WriteFile(local, []byte(ok("c")), 0o644)
	got, probs := LoadDB("")
	if dbNames(got) != "a c+" || keys(probs) != "config.toml:db.connections[1].kind config.toml:db.connections[1].user" {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
	}
	// Replaced, its mistakes are gone.
	os.WriteFile(local, []byte(ok("b")), 0o644)
	if got, probs := LoadDB(""); dbNames(got) != "a b+" || len(probs) != 0 {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
	}
	// A local entry with a mistake hides the entry of config.toml: the
	// connection is left out, not shown as config.toml has it.
	os.WriteFile(base, []byte(ok("a")+ok("b")), 0o644)
	os.WriteFile(local, []byte("[[db.connections]]\nname = \"a\"\nkind = \"postgres\"\nuser = \"u\"\nreadonly = true\n"), 0o644)
	if got, probs := LoadDB(""); dbNames(got) != "b" || keys(probs) != "config.local.toml:db.connections[0].readonly" {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
	}
	// The same name twice in config.local.toml is a mistake of the second;
	// the first replaces the one of config.toml.
	os.WriteFile(local, []byte(ok("a")+ok("a")), 0o644)
	if got, probs := LoadDB(""); dbNames(got) != "a+ b" || keys(probs) != "config.local.toml:db.connections[1].name" {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
	}
	// A list that is not a list of tables is a mistake of its file; the list
	// of the other file is used.
	os.WriteFile(local, []byte("[db]\nconnections = 1\n"), 0o644)
	if got, probs := LoadDB(""); dbNames(got) != "a b" || keys(probs) != "config.local.toml:db.connections" {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
	}
	// An entry without a name replaces nothing.
	os.WriteFile(local, []byte("[[db.connections]]\nkind = \"postgres\"\nuser = \"u\"\n"), 0o644)
	if got, probs := LoadDB(""); dbNames(got) != "a b" || keys(probs) != "config.local.toml:db.connections[0].name" {
		t.Fatalf("got %s, %s", dbNames(got), keys(probs))
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

// An entry with variants gives one connection for each variant, in the order
// written. A variant takes the keys it does not write from its entry.
func TestLoadDBVariants(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[[db.connections]]
name = "shop"
kind = "postgres"
user = "app"
database = "shop"
port = 5433

[[db.connections.variants]]
name = "local"

[[db.connections.variants]]
name = "dev"
host = "dev.example.com"
port = 5432
read-only = false

[[db.connections.variants]]
name = "prod"
host = "db.example.com"
user = "reader"
database = "shop_prod"
read-only = true

[[db.connections]]
name = "plain"
kind = "mysql"
user = "u"

[[db.connections]]
name = "guarded"
kind = "mysql"
read-only = true
variants = [{name = "a", user = "ua"}, {name = "b", user = "ub", read-only = false}]
`), 0o644)
	got, probs := LoadDB("")
	want := []DBConnection{
		{Name: "shop", Variant: "local", Kind: DBPostgres, Host: "localhost", Port: 5433, TLS: DBTLSPrefer, User: "app", Database: "shop"},
		{Name: "shop", Variant: "dev", Kind: DBPostgres, Host: "dev.example.com", Port: 5432, TLS: DBTLSPrefer, User: "app", Database: "shop"},
		{Name: "shop", Variant: "prod", Kind: DBPostgres, Host: "db.example.com", Port: 5433, TLS: DBTLSPrefer, User: "reader", Database: "shop_prod", ReadOnly: true},
		{Name: "plain", Kind: DBMySQL, Host: "localhost", Port: 3306, TLS: DBTLSPrefer, User: "u"},
		// The entry has no user (each variant has one), and its read-only is
		// what a variant gets unless it says otherwise.
		{Name: "guarded", Variant: "a", Kind: DBMySQL, Host: "localhost", Port: 3306, TLS: DBTLSPrefer, User: "ua", ReadOnly: true},
		{Name: "guarded", Variant: "b", Kind: DBMySQL, Host: "localhost", Port: 3306, TLS: DBTLSPrefer, User: "ub"},
	}
	if len(probs) != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, %v", got, probs)
	}
	for _, c := range want {
		if f, ok := FindDB(got, c.Name, c.Variant); !ok || f != c {
			t.Errorf("FindDB(%q, %q) = %+v, %v", c.Name, c.Variant, f, ok)
		}
	}
	// An entry with variants is not a connection by itself.
	if _, ok := FindDB(got, "shop", ""); ok {
		t.Error("FindDB found a connection with variants without a variant")
	}
	if _, ok := FindDB(got, "plain", "prod"); ok {
		t.Error("FindDB found a variant of a connection without variants")
	}
	if l := got[2].Label(); l != "shop (prod)" {
		t.Errorf("Label: %q", l)
	}
	if l := got[3].Label(); l != "plain" {
		t.Errorf("Label: %q", l)
	}
	// An empty list of variants is no variants.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("db.connections = [{name = \"m\", kind = \"mysql\", user = \"u\", variants = []}]\n"), 0o644)
	got, probs = LoadDB("")
	if len(probs) != 0 || len(got) != 1 || got[0].Variant != "" {
		t.Fatalf("got %+v, %v", got, probs)
	}
}

// A mistake in one variant leaves the whole entry out: none of its variants
// is listed. The other entries stay.
func TestLoadDBVariantMistakes(t *testing.T) {
	dir := userDir(t)
	const head = "[[db.connections]]\nname = \"ok\"\nkind = \"postgres\"\nuser = \"u\"\n[[db.connections]]\nname = \"x\"\nkind = \"mysql\"\n"
	for name, c := range map[string]struct{ body, key string }{
		"not a list":      {"user = \"u\"\nvariants = 1\n", "db.connections[1].variants"},
		"no name":         {"user = \"u\"\n[[db.connections.variants]]\nhost = \"h\"\n", "db.connections[1].variants[0].name"},
		"same name":       {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\n[[db.connections.variants]]\nname = \"a\"\n", "db.connections[1].variants[1].name"},
		"no user at all":  {"[[db.connections.variants]]\nname = \"a\"\nuser = \"u\"\n[[db.connections.variants]]\nname = \"b\"\n", "db.connections[1].variants[1].user"},
		"empty user":      {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\nuser = \"\"\n", "db.connections[1].variants[0].user"},
		"port range":      {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\nport = 0\n", "db.connections[1].variants[0].port"},
		"read-only":       {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\nread-only = 1\n", "db.connections[1].variants[0].read-only"},
		"slash in name":   {"user = \"u\"\n[[db.connections.variants]]\nname = \"b/c\"\n", "db.connections[1].variants[0].name"},
		"kind in variant": {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\nkind = \"postgres\"\n", "db.connections[1].variants[0].kind"},
		"misspelt key":    {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\nreadonly = true\n", "db.connections[1].variants[0].readonly"},
		"password":        {"user = \"u\"\n[[db.connections.variants]]\nname = \"a\"\npassword = \"secret\"\n", "db.connections[1].variants[0].password"},
		"entry mistake":   {"user = \"u\"\nport = 0\n[[db.connections.variants]]\nname = \"a\"\n[[db.connections.variants]]\nname = \"b\"\n", "db.connections[1].port"},
	} {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(head+c.body), 0o644)
		got, probs := LoadDB("")
		var texts []string
		for _, p := range probs {
			texts = append(texts, p.Text())
		}
		text := strings.Join(texts, "\n")
		if len(got) != 1 || got[0].Name != "ok" || len(probs) != 1 || !strings.Contains(text, c.key+": ") {
			t.Errorf("%s: connections %+v, problems %q", name, got, text)
		}
		if strings.Contains(text, "secret") {
			t.Errorf("%s: the problem shows the password: %q", name, text)
		}
		// A key that a variant cannot have is said to be no key of a variant:
		// `kind` is a key of a connection.
		if name == "kind in variant" && (len(probs) != 1 || probs[0].Code != "config.err.unknownvariant") {
			t.Errorf("%s: problems %+v", name, probs)
		}
	}
}

// `tls` and `tls-ca`: prefer when not written, tls-ca as an absolute path,
// and a variant takes them from its entry.
func TestLoadDBTLS(t *testing.T) {
	dir := userDir(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip(err)
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[[db.connections]]
name = "a"
kind = "postgres"
user = "u"

[[db.connections]]
name = "b"
kind = "mysql"
user = "u"
tls = "verify"
tls-ca = "~/ca.pem"

[[db.connections.variants]]
name = "inherits"

[[db.connections.variants]]
name = "own"
tls-ca = "/etc/../etc/ca.pem"

[[db.connections.variants]]
name = "socket"
host = "/run/mysqld/mysqld.sock"
tls = "disable"
tls-ca = "/etc/ca.pem"
`), 0o644)
	// The variant "socket" writes tls-ca without verify: a mistake, so the
	// connection b is left out.
	got, probs := LoadDB("")
	if len(got) != 1 || got[0].Name != "a" || got[0].TLS != DBTLSPrefer || got[0].TLSCA != "" {
		t.Fatalf("got %+v", got)
	}
	if len(probs) != 1 || probs[0].Key != "db.connections[1].variants[2].tls-ca" {
		t.Fatalf("problems %v", probs)
	}
	// Without its own tls-ca, it still takes the one of its entry, which is
	// not used with disable: a mistake too.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[[db.connections]]
name = "b"
kind = "mysql"
user = "u"
tls = "verify"
tls-ca = "~/ca.pem"

[[db.connections.variants]]
name = "socket"
host = "/run/mysqld/mysqld.sock"
tls = "disable"
`), 0o644)
	if got, probs := LoadDB(""); len(got) != 0 || len(probs) != 1 || probs[0].Key != "db.connections[0].variants[0].tls-ca" {
		t.Fatalf("an inherited tls-ca: %+v, %v", got, probs)
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`
[[db.connections]]
name = "b"
kind = "mysql"
user = "u"
tls = "verify"

[[db.connections.variants]]
name = "inherits"
tls-ca = "~/ca.pem"

[[db.connections.variants]]
name = "own"
tls-ca = "/etc/../etc/ca.pem"

[[db.connections.variants]]
name = "os"
host = "db.example.com"

[[db.connections.variants]]
name = "local"
host = "/run/mysqld/mysqld.sock"
tls = "disable"
`), 0o644)
	got, probs = LoadDB("")
	want := []DBConnection{
		{Name: "b", Variant: "inherits", Kind: DBMySQL, Host: "localhost", Port: 3306, User: "u", TLS: DBTLSVerify, TLSCA: filepath.Join(home, "ca.pem")},
		{Name: "b", Variant: "own", Kind: DBMySQL, Host: "localhost", Port: 3306, User: "u", TLS: DBTLSVerify, TLSCA: "/etc/ca.pem"},
		{Name: "b", Variant: "os", Kind: DBMySQL, Host: "db.example.com", Port: 3306, User: "u", TLS: DBTLSVerify},
		{Name: "b", Variant: "local", Kind: DBMySQL, Host: "/run/mysqld/mysqld.sock", Port: 3306, User: "u", TLS: DBTLSDisable},
	}
	if len(probs) != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, %v", got, probs)
	}
	// The login takes them.
	if l := got[1].Login(got[1].Access(DBHuman)); l.TLS != DBTLSVerify || l.TLSCA != "/etc/ca.pem" {
		t.Errorf("login %+v", l)
	}
}

func TestLoadDBTLSMistakes(t *testing.T) {
	dir := userDir(t)
	for name, c := range map[string]struct{ body, key string }{
		"unknown tls":      {"tls = \"yes\"\n", "db.connections[0].tls"},
		"tls not a string": {"tls = true\n", "db.connections[0].tls"},
		// Only the wrong tls is reported, not the tls-ca that goes with it.
		"unknown tls, tls-ca":       {"tls = \"verfy\"\ntls-ca = \"/etc/ca.pem\"\n", "db.connections[0].tls"},
		"tls not a string, tls-ca":  {"tls = true\ntls-ca = \"/etc/ca.pem\"\n", "db.connections[0].tls"},
		"variant tls wrong, tls-ca": {"tls = \"verify\"\ntls-ca = \"/etc/ca.pem\"\n[[db.connections.variants]]\nname = \"a\"\ntls = \"verfy\"\n", "db.connections[0].variants[0].tls"},
		"relative tls-ca":           {"tls = \"verify\"\ntls-ca = \"ca.pem\"\n", "db.connections[0].tls-ca"},
		"empty tls-ca":              {"tls = \"verify\"\ntls-ca = \"\"\n", "db.connections[0].tls-ca"},
		"tls-ca with prefer":        {"tls-ca = \"/etc/ca.pem\"\n", "db.connections[0].tls-ca"},
		"tls-ca with require":       {"tls = \"require\"\ntls-ca = \"/etc/ca.pem\"\n", "db.connections[0].tls-ca"},
		"socket and require":        {"host = \"/run/postgresql\"\ntls = \"require\"\n", "db.connections[0].tls"},
		"socket and verify":         {"host = \"/run/postgresql\"\ntls = \"verify\"\n", "db.connections[0].tls"},
		"variant on a socket":       {"tls = \"verify\"\n[[db.connections.variants]]\nname = \"a\"\nhost = \"/run/postgresql\"\n", "db.connections[0].variants[0].tls"},
	} {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[[db.connections]]\nname = \"x\"\nkind = \"postgres\"\nuser = \"u\"\n"+c.body), 0o644)
		got, probs := LoadDB("")
		if len(got) != 0 || len(probs) != 1 || probs[0].Key != c.key {
			t.Errorf("%s: %+v, %v", name, got, probs)
		}
	}
	// On a socket, prefer and disable are fine.
	for _, mode := range []string{DBTLSPrefer, DBTLSDisable} {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[[db.connections]]\nname = \"x\"\nkind = \"postgres\"\nuser = \"u\"\nhost = \"/run/postgresql\"\ntls = \""+mode+"\"\n"), 0o644)
		if got, probs := LoadDB(""); len(got) != 1 || len(probs) != 0 || got[0].TLS != mode {
			t.Errorf("%s on a socket: %+v, %v", mode, got, probs)
		}
	}
}
