package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgpassfile"

	"github.com/mm1995tk/kisui-terminal/config"
)

// Source is where a password came from.
type Source string

const (
	// SourceKeychain: the keychain of the OS (macOS only, keychain_darwin.go).
	SourceKeychain Source = "keychain"
	// SourceFile: ~/.pgpass (PostgreSQL) or ~/.my.cnf (MySQL).
	SourceFile Source = "file"
	// SourceRequest: the window sent it with the request.
	SourceRequest Source = "request"
	// SourceMemory: the window sent it with an earlier request, and it
	// worked.
	SourceMemory Source = "memory"
)

// Typed is true for a password the user typed in the window (now or
// earlier), false for one found on this machine. When the database refuses a
// typed one, asking again helps; when it refuses a found one, the user has
// to fix the place it was found.
func (s Source) Typed() bool { return s == SourceRequest || s == SourceMemory }

// ErrPasswordRequired is what Passwords.Find returns when there is no
// password anywhere.
var ErrPasswordRequired = errors.New("a password is required")

// Passwords finds the password of a connection, in this order:
//
//  1. the keychain of the OS (macOS);
//  2. ~/.pgpass (PostgreSQL) or ~/.my.cnf (MySQL);
//  3. the password the window sent with the request, or with an earlier
//     request (remembered in memory only, never written to a file).
//
// A password found on the machine wins over a typed one, so a connection
// whose password is in the keychain or a file never asks.
//
// The zero value looks in the real keychain and the real files.
type Passwords struct {
	// Keychain looks a connection up in the keychain. nil means the keychain
	// of the OS.
	Keychain func(ctx context.Context, c config.DBConnection) (password string, ok bool)
	// File looks a connection up in the password file of its kind. nil means
	// ~/.pgpass and ~/.my.cnf.
	File func(c config.DBConnection) (password string, ok bool)

	mu         sync.Mutex
	remembered map[string]string // by identity
}

// Find returns the password of c and where it came from. typed is the
// password the window sent with this request, nil when it sent none (an
// empty password is a password: a login without one). The error is
// ErrPasswordRequired when there is none anywhere.
func (p *Passwords) Find(ctx context.Context, c config.DBConnection, typed *string) (string, Source, error) {
	keychain, file := p.Keychain, p.File
	if keychain == nil {
		keychain = func(ctx context.Context, c config.DBConnection) (string, bool) {
			return keychainPassword(ctx, KeychainAccount(c))
		}
	}
	if file == nil {
		file = filePassword
	}
	if pw, ok := keychain(ctx, c); ok {
		return pw, SourceKeychain, nil
	}
	if pw, ok := file(c); ok {
		return pw, SourceFile, nil
	}
	if typed != nil {
		return *typed, SourceRequest, nil
	}
	p.mu.Lock()
	pw, ok := p.remembered[identity(c)]
	p.mu.Unlock()
	if ok {
		return pw, SourceMemory, nil
	}
	return "", "", ErrPasswordRequired
}

// Remember keeps a typed password that worked, until Forget or the end of
// the process.
func (p *Passwords) Remember(c config.DBConnection, password string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.remembered == nil {
		p.remembered = map[string]string{}
	}
	p.remembered[identity(c)] = password
}

// Forget drops the remembered password of c.
func (p *Passwords) Forget(c config.DBConnection) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.remembered, identity(c))
}

// identity is what a remembered password belongs to: not the name (and the
// variant) alone but the server and the user too, so that a password is never
// sent to another server after the settings were edited. Each variant of a
// connection has its own.
func identity(c config.DBConnection) string {
	return strings.Join([]string{c.Name, c.Variant, c.Kind, c.Host, strconv.Itoa(c.Port), c.User}, "\x00")
}

// KeychainService is the service name of the keychain items. The account is
// KeychainAccount. On macOS:
//
//	security add-generic-password -s kisui-terminal-db -a <account> -w
const KeychainService = "kisui-terminal-db"

// KeychainAccount is the account of the keychain item of c: the name of the
// connection, and for a variant the name, a slash and the variant
// ("shop/prod"). Each variant has an item of its own, and the item of one is
// never tried for another: the password of production is not sent to the
// server of another environment. The name of a variant holds no slash
// (config.LoadDB), so the last slash is the border and two variants never
// have the same account. A connection without variants whose own name is
// "shop/prod" does have the account of that variant; docs/database.md tells
// the user not to name one so.
func KeychainAccount(c config.DBConnection) string {
	if c.Variant == "" {
		return c.Name
	}
	return c.Name + "/" + c.Variant
}

// filePassword looks c up in the password file of its kind in the home
// directory.
func filePassword(c config.DBConnection) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	switch c.Kind {
	case config.DBPostgres:
		path := os.Getenv("PGPASSFILE")
		if path == "" {
			path = filepath.Join(home, ".pgpass")
		}
		return pgpassPassword(path, c)
	case config.DBMySQL:
		return mycnfPassword(filepath.Join(home, ".my.cnf"), c)
	}
	return "", false
}

// pgpassPassword looks c up in a pgpass file, with the rules of libpq:
// `host:port:database:user:password` lines, * for anything, the first match
// wins. A connection over a Unix socket matches the host "localhost".
func pgpassPassword(path string, c config.DBConnection) (string, bool) {
	f, err := pgpassfile.ReadPassfile(path)
	if err != nil {
		return "", false
	}
	host := c.Host
	if strings.HasPrefix(host, "/") {
		host = "localhost"
	}
	pw := f.FindPassword(host, strconv.Itoa(c.Port), postgresDatabase(c), c.User)
	return pw, pw != ""
}

// postgresDatabase is the database a PostgreSQL connection opens: the one
// named like the user when none is written.
func postgresDatabase(c config.DBConnection) string {
	if c.Database == "" {
		return c.User
	}
	return c.Database
}

// mycnfPassword takes the password of the [client] group of a MySQL option
// file. The file names no server per password, so the password is used only
// when what [client] does say (user, host, port) is the connection's: a
// password written for one account is not sent to another server.
func mycnfPassword(path string, c config.DBConnection) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	client := mycnfGroup(string(data), "client")
	pw, ok := client["password"]
	if !ok {
		return "", false
	}
	if u, has := client["user"]; has && u != c.User {
		return "", false
	}
	if h, has := client["host"]; has && h != c.Host {
		return "", false
	}
	if p, has := client["port"]; has && p != strconv.Itoa(c.Port) {
		return "", false
	}
	return pw, true
}

// mycnfGroup reads the options of one group of a MySQL option file: lines
// `name = value` after `[group]`; # and ; start a comment; a value may be in
// quotes; a later line wins. `!include` lines are not followed.
func mycnfGroup(text, group string) map[string]string {
	out := map[string]string{}
	in := false
	for line := range strings.Lines(text) {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' || line[0] == ';' || line[0] == '!' {
			continue
		}
		if line[0] == '[' {
			name, _, _ := strings.Cut(line[1:], "]")
			in = strings.EqualFold(strings.TrimSpace(name), group)
			continue
		}
		if !in {
			continue
		}
		name, value, _ := strings.Cut(line, "=")
		// MySQL takes - and _ in an option name as the same.
		name = strings.ReplaceAll(strings.TrimSpace(name), "-", "_")
		out[name] = mycnfValue(strings.TrimSpace(value))
	}
	return out
}

// mycnfValue is the value of an option: without its quotes when quoted, up
// to a # otherwise, with the escapes of an option file (\\, \s, \n, ...).
func mycnfValue(v string) string {
	quote := byte(0)
	if v != "" && (v[0] == '"' || v[0] == '\'') {
		quote = v[0]
		v = v[1:]
	}
	var sb strings.Builder
	for i := 0; i < len(v); i++ {
		ch := v[i]
		switch {
		case ch == '\\' && i+1 < len(v):
			i++
			switch v[i] {
			case 'b':
				sb.WriteByte('\b')
			case 't':
				sb.WriteByte('\t')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 's':
				sb.WriteByte(' ')
			case '\\', '"', '\'':
				sb.WriteByte(v[i])
			default:
				sb.WriteByte('\\')
				sb.WriteByte(v[i])
			}
		case quote != 0 && ch == quote:
			return sb.String()
		case quote == 0 && ch == '#':
			return strings.TrimSpace(sb.String())
		default:
			sb.WriteByte(ch)
		}
	}
	return sb.String()
}
