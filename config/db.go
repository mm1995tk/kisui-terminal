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

// DBConnection is one database to log in to: where it is and who logs in. A
// [[db.connections]] entry without variants gives one; an entry with
// [[db.connections.variants]] gives one for each variant (the same database
// in another environment: local, dev, prod), all with the Name of the entry.
// Name and Variant together are unique in the list, and are what a request
// names a connection by.
//
// It holds no password; a password is never written in the settings
// (internal/db finds it).
type DBConnection struct {
	// Name is what the user calls the connection (the entry).
	Name string
	// Variant is the name of the environment variant, "" for an entry without
	// variants. The variants of one entry follow each other in the list, in
	// the order they are written.
	Variant string
	// Kind is DBPostgres or DBMySQL. The variants of an entry have one kind.
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

// Label is the connection as it is shown to a person: the name, and the
// variant in parentheses when there is one ("shop (prod)").
func (c DBConnection) Label() string {
	if c.Variant == "" {
		return c.Name
	}
	return c.Name + " (" + c.Variant + ")"
}

// FindDB is the connection of list with this name and variant. An entry with
// variants has no connection for the variant "": the caller has to say which
// environment it means.
func FindDB(list []DBConnection, name, variant string) (DBConnection, bool) {
	for _, c := range list {
		if c.Name == name && c.Variant == variant {
			return c, true
		}
	}
	return DBConnection{}, false
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
		cs, ps := dbConnection(e)
		if len(ps) == 0 && seen[cs[0].Name] {
			ps = append(ps, Problem{Key: "name", Code: "config.err.dupname", Args: []any{cs[0].Name}})
		}
		for _, p := range ps {
			bad(key+"."+p.Key, p.Code, p.Args...)
		}
		if len(ps) == 0 {
			seen[cs[0].Name] = true
			conns = append(conns, cs...)
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

// dbWhereKeys are the keys that say where a database is and who logs in. An
// entry and a variant can both have them: a variant takes the ones it does
// not write from its entry.
var dbWhereKeys = []string{"host", "port", "user", "database", "read-only"}

// dbKeys are the keys of a [[db.connections]] entry, and dbVariantKeys the
// keys of a [[db.connections.variants]] entry.
var (
	dbKeys        = append([]string{"name", "kind"}, append(slices.Clone(dbWhereKeys), "variants")...)
	dbVariantKeys = append([]string{"name"}, dbWhereKeys...)
)

// unknownDBKeys are the keys of an entry that are not among known, in order.
// One is a mistake, not something to skip: a misspelt `read-only` would
// otherwise give a connection that can write while its settings look
// protected. `password` is not among them: it has a message of its own.
func unknownDBKeys(e map[string]any, known []string) []string {
	var out []string
	for _, key := range slices.Sorted(maps.Keys(e)) {
		if !slices.Contains(known, key) && key != "password" {
			out = append(out, key)
		}
	}
	return out
}

// dbEntry reads the keys of one table: a [[db.connections]] entry or one of
// its variants. Its problems have the key inside the table.
type dbEntry struct {
	e     map[string]any
	probs []Problem
}

func (d *dbEntry) bad(key, code string, args ...any) {
	d.probs = append(d.probs, Problem{Key: key, Code: code, Args: args})
}

// str reads a string key. ok is false when it is missing or wrong.
func (d *dbEntry) str(key string, required bool) (string, bool) {
	v, has := d.e[key]
	if !has {
		if required {
			d.bad(key, "config.err.required")
		}
		return "", false
	}
	s, ok := v.(string)
	switch {
	case !ok:
		d.bad(key, "config.err.string")
	case strings.TrimSpace(s) == "" && required:
		d.bad(key, "config.err.required")
	case strings.ContainsFunc(s, unicode.IsControl):
		d.bad(key, "config.err.control")
	default:
		return s, true
	}
	return "", false
}

// name reads the key `name`: required, at most dbNameMax characters.
func (d *dbEntry) name() string {
	s, ok := d.str("name", true)
	if !ok {
		return ""
	}
	if len([]rune(s)) > dbNameMax {
		d.bad("name", "config.err.toolong", dbNameMax)
		return ""
	}
	return strings.TrimSpace(s)
}

// unknown reports the keys that are not among known, with the problem code
// (which says whose keys known are: a connection's or a variant's), and
// `password`. The value of a password is not put in the problem.
func (d *dbEntry) unknown(known []string, code string) {
	for _, key := range unknownDBKeys(d.e, known) {
		d.bad(key, code, strings.Join(known, ", "))
	}
	if _, has := d.e["password"]; has {
		d.bad("password", "config.err.password")
	}
}

// dbWhere is what the dbWhereKeys of one table say. A key that is not
// written (or is wrong, which is reported) is nil.
type dbWhere struct {
	host, user, database *string
	port                 *int
	readOnly             *bool
}

// where reads the dbWhereKeys.
func (d *dbEntry) where() (w dbWhere) {
	if s, ok := d.str("host", false); ok && s != "" {
		w.host = &s
	}
	if v, has := d.e["port"]; has {
		if n, ok := integer(v); !ok {
			d.bad("port", "config.err.int")
		} else if n < 1 || n > 65535 {
			d.bad("port", "config.err.port")
		} else {
			p := int(n)
			w.port = &p
		}
	}
	// A user that is written must not be empty, in an entry and in a variant.
	if _, has := d.e["user"]; has {
		if s, ok := d.str("user", true); ok {
			w.user = &s
		}
	}
	if s, ok := d.str("database", false); ok {
		w.database = &s
	}
	if v, has := d.e["read-only"]; has {
		if b, ok := v.(bool); !ok {
			d.bad("read-only", "config.err.bool")
		} else {
			w.readOnly = &b
		}
	}
	return w
}

// over is w with the keys that v writes taken from v.
func (w dbWhere) over(v dbWhere) dbWhere {
	if v.host != nil {
		w.host = v.host
	}
	if v.port != nil {
		w.port = v.port
	}
	if v.user != nil {
		w.user = v.user
	}
	if v.database != nil {
		w.database = v.database
	}
	if v.readOnly != nil {
		w.readOnly = v.readOnly
	}
	return w
}

// fill puts w in c, with the defaults for the keys nobody wrote. ok is false
// when there is no user (the only key without a default).
func (w dbWhere) fill(c *DBConnection) (ok bool) {
	c.Host = "localhost"
	if w.host != nil {
		c.Host = *w.host
	}
	c.Port = 5432
	if c.Kind == DBMySQL {
		c.Port = 3306
	}
	if w.port != nil {
		c.Port = *w.port
	}
	if w.database != nil {
		c.Database = *w.database
	}
	if w.readOnly != nil {
		c.ReadOnly = *w.readOnly
	}
	if w.user == nil {
		return false
	}
	c.User = *w.user
	return true
}

// dbConnection reads one [[db.connections]] entry: one connection, or one
// for each of its variants. The Key of a problem is the key inside the entry
// (`port`, `variants[1].port`). With a problem anywhere, in a variant too,
// the entry gives no connection: half of the environments of a database
// would look like the whole.
func dbConnection(e map[string]any) (conns []DBConnection, probs []Problem) {
	d := &dbEntry{e: e}
	d.unknown(dbKeys, "config.err.unknown")
	base := DBConnection{Name: d.name()}
	if s, ok := d.str("kind", true); ok {
		if s != DBPostgres && s != DBMySQL {
			d.bad("kind", "config.err.oneof", DBPostgres+", "+DBMySQL)
		} else {
			base.Kind = s
		}
	}
	w := d.where()
	var variants []map[string]any
	if v, has := e["variants"]; has {
		var ok bool
		if variants, ok = tables(v); !ok {
			d.bad("variants", "config.err.tables")
		}
	}
	// An entry without variants (an empty list is none) is one connection.
	if len(variants) == 0 {
		if !w.fill(&base) && e["user"] == nil {
			d.bad("user", "config.err.required")
		}
		return []DBConnection{base}, d.probs
	}
	seen := map[string]bool{}
	for i, ve := range variants {
		vd := &dbEntry{e: ve}
		vd.unknown(dbVariantKeys, "config.err.unknownvariant")
		c := base
		c.Variant = vd.name()
		// The keychain account of a variant is "name/variant" (internal/db):
		// without a slash in the variant, the last slash of an account is the
		// border, so two variants never share an item.
		if strings.Contains(c.Variant, "/") {
			vd.bad("name", "config.err.noslash")
		}
		if c.Variant != "" && seen[c.Variant] {
			vd.bad("name", "config.err.dupvariant", c.Variant)
		}
		seen[c.Variant] = true
		// The user may be written in the entry, in the variant, or in both.
		// When a written one is wrong, that is the problem to report, not that
		// it is missing.
		if !w.over(vd.where()).fill(&c) && e["user"] == nil && ve["user"] == nil {
			vd.bad("user", "config.err.required")
		}
		for _, p := range vd.probs {
			d.bad(fmt.Sprintf("variants[%d].%s", i, p.Key), p.Code, p.Args...)
		}
		conns = append(conns, c)
	}
	return conns, d.probs
}
