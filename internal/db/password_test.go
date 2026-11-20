package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
)

// The order of the places a password is looked for: the keychain, the
// password file, the password the window sent (now, then earlier), and the
// error when there is none.
func TestPasswordOrder(t *testing.T) {
	c := config.DBConnection{Name: "dev", Kind: config.DBPostgres, Host: "h", Port: 5432, User: "u"}
	inKeychain, inFile := true, true
	p := &Passwords{
		Keychain: func(_ context.Context, got config.DBConnection) (string, bool) {
			if got != c {
				t.Errorf("keychain asked for %+v", got)
			}
			return "from-keychain", inKeychain
		},
		File: func(config.DBConnection) (string, bool) { return "from-file", inFile },
	}
	typed := "typed"
	p.Remember(c, "remembered")
	find := func(typed *string) (string, Source, error) { return p.Find(context.Background(), c, typed) }

	if pw, src, err := find(&typed); err != nil || pw != "from-keychain" || src != SourceKeychain {
		t.Errorf("with everything: %q, %q, %v", pw, src, err)
	}
	inKeychain = false
	if pw, src, err := find(&typed); err != nil || pw != "from-file" || src != SourceFile {
		t.Errorf("without the keychain: %q, %q, %v", pw, src, err)
	}
	inFile = false
	if pw, src, err := find(&typed); err != nil || pw != "typed" || src != SourceRequest {
		t.Errorf("without the file: %q, %q, %v", pw, src, err)
	}
	// An empty password is a password.
	empty := ""
	if pw, src, err := find(&empty); err != nil || pw != "" || src != SourceRequest {
		t.Errorf("an empty typed password: %q, %q, %v", pw, src, err)
	}
	if pw, src, err := find(nil); err != nil || pw != "remembered" || src != SourceMemory {
		t.Errorf("without a typed one: %q, %q, %v", pw, src, err)
	}
	p.Forget(c)
	if _, _, err := find(nil); !errors.Is(err, ErrPasswordRequired) {
		t.Errorf("with nothing: %v", err)
	}
}

// A remembered password belongs to the server and the user, not to the name
// alone.
func TestRememberedPasswordIsPerServer(t *testing.T) {
	none := func(config.DBConnection) (string, bool) { return "", false }
	p := &Passwords{Keychain: func(context.Context, config.DBConnection) (string, bool) { return "", false }, File: none}
	c := config.DBConnection{Name: "dev", Kind: config.DBMySQL, Host: "a", Port: 3306, User: "u"}
	p.Remember(c, "pw")
	moved := c
	moved.Host = "b"
	if _, _, err := p.Find(context.Background(), moved, nil); !errors.Is(err, ErrPasswordRequired) {
		t.Errorf("the password of host a was found for host b: %v", err)
	}
	if pw, _, err := p.Find(context.Background(), c, nil); err != nil || pw != "pw" {
		t.Errorf("%q, %v", pw, err)
	}
}

func TestPgpass(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pgpass")
	os.WriteFile(path, []byte("# comment\ndb.example.com:5432:shop:app:p1\nlocalhost:*:*:local:p2\n*:*:*:any:p\\:3\n"), 0o600)
	for _, c := range []struct {
		conn config.DBConnection
		want string
	}{
		{config.DBConnection{Host: "db.example.com", Port: 5432, User: "app", Database: "shop"}, "p1"},
		{config.DBConnection{Host: "db.example.com", Port: 5433, User: "app", Database: "shop"}, ""},
		// No database: the one named like the user.
		{config.DBConnection{Host: "localhost", Port: 1, User: "local"}, "p2"},
		// A Unix socket matches localhost.
		{config.DBConnection{Host: "/run/postgresql", Port: 5432, User: "local"}, "p2"},
		{config.DBConnection{Host: "x", Port: 5432, User: "any"}, "p:3"},
		{config.DBConnection{Host: "x", Port: 5432, User: "nobody"}, ""},
	} {
		got, ok := pgpassPassword(path, c.conn)
		if got != c.want || ok != (c.want != "") {
			t.Errorf("%+v: %q, %v; want %q", c.conn, got, ok, c.want)
		}
	}
	if _, ok := pgpassPassword(filepath.Join(t.TempDir(), "missing"), config.DBConnection{}); ok {
		t.Error("a missing file gave a password")
	}
}

func TestMycnf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "my.cnf")
	conn := config.DBConnection{Host: "db", Port: 3306, User: "app"}
	for name, c := range map[string]struct {
		file string
		want string
		ok   bool
	}{
		"plain":           {"[client]\npassword = secret\n", "secret", true},
		"other groups":    {"[mysqld]\npassword = no\n[client]\npassword=yes\n[mysqldump]\npassword = no\n", "yes", true},
		"quoted":          {"[client]\npassword = \"p#ss word\"  # the password\n", "p#ss word", true},
		"single quoted":   {"[client]\npassword='a\\'b'\n", "a'b", true},
		"comment":         {"[client]\n; x\n# y\npassword = abc # tail\n", "abc", true},
		"escapes":         {"[client]\npassword = a\\sb\\\\c\n", "a b\\c", true},
		"empty":           {"[client]\npassword =\n", "", true},
		"none":            {"[client]\nuser = app\n", "", false},
		"same user":       {"[client]\nuser = app\nhost = db\nport = 3306\npassword = p\n", "p", true},
		"another user":    {"[client]\nuser = root\npassword = p\n", "", false},
		"another host":    {"[client]\nhost = elsewhere\npassword = p\n", "", false},
		"another port":    {"[client]\nport = 3307\npassword = p\n", "", false},
		"group name case": {"[ Client ]\npassword = p\n", "p", true},
	} {
		os.WriteFile(path, []byte(c.file), 0o600)
		got, ok := mycnfPassword(path, conn)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: %q, %v; want %q, %v", name, got, ok, c.want, c.ok)
		}
	}
}

// The real files are the ones in the home directory.
func TestFilePassword(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PGPASSFILE", "")
	os.WriteFile(filepath.Join(home, ".pgpass"), []byte("*:*:*:u:pg-pw\n"), 0o600)
	os.WriteFile(filepath.Join(home, ".my.cnf"), []byte("[client]\npassword = my-pw\n"), 0o600)
	if pw, ok := filePassword(config.DBConnection{Kind: config.DBPostgres, Host: "h", Port: 5432, User: "u"}); !ok || pw != "pg-pw" {
		t.Errorf("postgres: %q, %v", pw, ok)
	}
	if pw, ok := filePassword(config.DBConnection{Kind: config.DBMySQL, Host: "h", Port: 3306, User: "u"}); !ok || pw != "my-pw" {
		t.Errorf("mysql: %q, %v", pw, ok)
	}
	// The zero Passwords uses them (the keychain has nothing outside macOS;
	// on macOS the test connection is not in it).
	var p Passwords
	if pw, src, err := p.Find(context.Background(), config.DBConnection{Name: "kisui-test-not-in-keychain", Kind: config.DBMySQL, Host: "h", Port: 3306, User: "u"}, nil); err != nil || pw != "my-pw" || src != SourceFile {
		t.Errorf("zero Passwords: %q, %q, %v", pw, src, err)
	}
}

// Each variant of a connection has a keychain item and a remembered password
// of its own; a connection without variants keeps the account it had.
func TestPasswordPerVariant(t *testing.T) {
	plain := config.DBConnection{Name: "shop", Kind: config.DBPostgres, Host: "h", Port: 5432, User: "u"}
	local, prod := plain, plain
	local.Variant, prod.Variant = "local", "prod"
	for c, want := range map[config.DBConnection]string{plain: "shop", local: "shop/local", prod: "shop/prod"} {
		if got := KeychainAccount(c); got != want {
			t.Errorf("KeychainAccount(%+v) = %q, want %q", c, got, want)
		}
	}
	none := func(config.DBConnection) (string, bool) { return "", false }
	p := &Passwords{Keychain: func(context.Context, config.DBConnection) (string, bool) { return "", false }, File: none}
	p.Remember(prod, "prod-secret")
	if pw, src, err := p.Find(context.Background(), prod, nil); err != nil || pw != "prod-secret" || src != SourceMemory {
		t.Errorf("the variant itself: %q, %q, %v", pw, src, err)
	}
	// The same server and user, but another variant (or none): not sent.
	for _, c := range []config.DBConnection{local, plain} {
		if _, _, err := p.Find(context.Background(), c, nil); !errors.Is(err, ErrPasswordRequired) {
			t.Errorf("%q got the password of prod: %v", c.Variant, err)
		}
	}
}
