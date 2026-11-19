package config

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"unicode"
)

// The kinds of database a [[db.connections]] entry can name.
const (
	DBPostgres = "postgres"
	DBMySQL    = "mysql"
)

// DBConnection is one [[db.connections]] entry: where a database is and who
// logs in. It holds no password; a password is never written in the settings
// (internal/db finds it).
type DBConnection struct {
	// Name is what the user calls the connection. It is unique in the list.
	Name string
	// Kind is DBPostgres or DBMySQL.
	Kind string
	// Host is a host name or an address. One that starts with / is a Unix
	// socket: the folder of the socket for PostgreSQL, the socket file for
	// MySQL.
	Host string
	// Port is the TCP port. For a PostgreSQL socket it chooses the socket file
	// in the folder; for a MySQL socket it is not used.
	Port int
	User string
	// Database may be "": PostgreSQL then uses the database named like the
	// user, MySQL selects none.
	Database string
	// ReadOnly makes every statement run in a read-only transaction.
	ReadOnly bool
}

// dbNameMax is the longest name of a connection, in characters.
const dbNameMax = 100

// LoadDB reads [[db.connections]] from kisui-terminal's configuration
// directory. The list of config.local.toml, when that file has one, replaces
// the list of config.toml as a whole, as [[gui.machines]] does: entries are
// not merged one by one.
//
// It is apart from Load because it is read each time the list is asked for,
// not once at startup, so that a connection can be added without stopping
// `kisui serve` (which would end its terminals). For the same reason a mistake
// here does not stop anything: the entry with the mistake is left out, the
// others are returned, and the mistakes come back as problems.
func LoadDB(suffix string) (conns []DBConnection, probs []Problem) {
	dir, ok := UserDir(suffix)
	if !ok {
		return nil, nil
	}
	// The mistakes in the list in use. A list that was replaced takes its
	// mistakes with it.
	var listProbs []Problem
	for _, name := range files {
		path := filepath.Join(dir, name)
		raw, ps, found := readTOML(path)
		probs = append(probs, ps...)
		if !found {
			continue
		}
		list, ps, has := dbConnections(raw, path)
		if has {
			conns, listProbs = list, ps
		} else {
			probs = append(probs, ps...)
		}
	}
	return conns, append(probs, listProbs...)
}

// dbConnections takes [[db.connections]] out of a decoded file. has is false
// when the file has no list: the key is not written, or is not a list (which
// is a problem).
func dbConnections(raw map[string]any, path string) (conns []DBConnection, probs []Problem, has bool) {
	bad := func(key, code string, args ...any) {
		probs = append(probs, Problem{File: path, Key: key, Code: code, Args: args})
	}
	v, ok := raw["db"]
	if !ok {
		return nil, nil, false
	}
	t, ok := v.(map[string]any)
	if !ok {
		bad("db", "config.err.table")
		return nil, probs, false
	}
	v, ok = t["connections"]
	if !ok {
		return nil, nil, false
	}
	list, ok := tables(v)
	if !ok {
		bad("db.connections", "config.err.tables")
		return nil, probs, false
	}
	seen := map[string]bool{}
	for i, e := range list {
		key := fmt.Sprintf("db.connections[%d]", i)
		c, ps := dbConnection(e)
		if len(ps) == 0 && seen[c.Name] {
			ps = append(ps, Problem{Key: "name", Code: "config.err.dupname", Args: []any{c.Name}})
		}
		for _, p := range ps {
			bad(key+"."+p.Key, p.Code, p.Args...)
		}
		if len(ps) == 0 {
			seen[c.Name] = true
			conns = append(conns, c)
		}
	}
	return conns, probs, true
}

// tables is v as an array of tables. BurntSushi/toml decodes one as
// []map[string]any, and the empty array (`x = []`) as []any.
func tables(v any) ([]map[string]any, bool) {
	switch l := v.(type) {
	case []map[string]any:
		return l, true
	case []any:
		out := make([]map[string]any, 0, len(l))
		for _, e := range l {
			t, ok := e.(map[string]any)
			if !ok {
				return nil, false
			}
			out = append(out, t)
		}
		return out, true
	}
	return nil, false
}

// dbKeys are the keys of a [[db.connections]] entry.
var dbKeys = []string{"name", "kind", "host", "port", "user", "database", "read-only"}

// dbConnection reads one entry. The Key of a problem is the key inside the
// entry.
func dbConnection(e map[string]any) (c DBConnection, probs []Problem) {
	bad := func(key, code string, args ...any) {
		probs = append(probs, Problem{Key: key, Code: code, Args: args})
	}
	// str reads a string key. ok is false when it is missing or wrong.
	str := func(key string, required bool) (string, bool) {
		v, has := e[key]
		if !has {
			if required {
				bad(key, "config.err.required")
			}
			return "", false
		}
		s, ok := v.(string)
		switch {
		case !ok:
			bad(key, "config.err.string")
		case strings.TrimSpace(s) == "" && required:
			bad(key, "config.err.required")
		case strings.ContainsFunc(s, unicode.IsControl):
			bad(key, "config.err.control")
		default:
			return s, true
		}
		return "", false
	}
	// A key that is not known is a mistake, not something to skip: a
	// misspelt `read-only` would otherwise give a connection that can write
	// while its settings look protected.
	for _, key := range slices.Sorted(maps.Keys(e)) {
		if !slices.Contains(dbKeys, key) && key != "password" {
			bad(key, "config.err.unknown", strings.Join(dbKeys, ", "))
		}
	}
	// The value is not put in the problem: it is a password.
	if _, has := e["password"]; has {
		bad("password", "config.err.password")
	}
	if s, ok := str("name", true); ok {
		if len([]rune(s)) > dbNameMax {
			bad("name", "config.err.toolong", dbNameMax)
		} else {
			c.Name = strings.TrimSpace(s)
		}
	}
	if s, ok := str("kind", true); ok {
		if s != DBPostgres && s != DBMySQL {
			bad("kind", "config.err.oneof", DBPostgres+", "+DBMySQL)
		} else {
			c.Kind = s
		}
	}
	c.Host = "localhost"
	if s, ok := str("host", false); ok && s != "" {
		c.Host = s
	}
	if c.Kind == DBMySQL {
		c.Port = 3306
	} else {
		c.Port = 5432
	}
	if v, has := e["port"]; has {
		if n, ok := integer(v); !ok {
			bad("port", "config.err.int")
		} else if n < 1 || n > 65535 {
			bad("port", "config.err.port")
		} else {
			c.Port = int(n)
		}
	}
	c.User, _ = str("user", true)
	c.Database, _ = str("database", false)
	if v, has := e["read-only"]; has {
		if b, ok := v.(bool); !ok {
			bad("read-only", "config.err.bool")
		} else {
			c.ReadOnly = b
		}
	}
	return c, probs
}
