package config

import (
	"maps"
	"slices"
	"strings"
	"time"
)

// DBActor is who asks for something on a database connection.
type DBActor string

const (
	// DBHuman is a person: a request of the window.
	DBHuman DBActor = "human"
	// DBAgent is a coding agent: a request of the `kisui db` commands.
	DBAgent DBActor = "agent"
)

// DBRun is how far somebody may run SQL on a connection. The levels are in
// order: each allows what the one before it allows.
type DBRun string

const (
	// DBRunNone: no statement is run.
	DBRunNone DBRun = "none"
	// DBRunRead: a statement runs in a read-only transaction, so the database
	// itself refuses anything that writes.
	DBRunRead DBRun = "read"
	// DBRunFree: a statement runs as it is.
	DBRunFree DBRun = "free"
)

// dbRuns are the values of the key `run`, weakest first.
var dbRuns = []DBRun{DBRunNone, DBRunRead, DBRunFree}

// DBPermission is one entry of [db.permissions]: a name, and what the one it
// is given to may do. A connection names one for a person and one for a
// coding agent. It is comparable, and its zero value is "none named".
type DBPermission struct {
	// Name is the key of the entry in [db.permissions].
	Name string
	// Run is how far statements are run.
	Run DBRun
	// Propose lets a coding agent write SQL into the input of a database tab,
	// for a person to run. It says nothing for a person.
	Propose bool
	// AgentUser is the database user a coding agent logs in as, "" for the
	// user of the connection. It says nothing for a person. What that user
	// may do in the database (GRANT) is the fine control: kisui does not read
	// a statement to refuse it.
	AgentUser string
	// ElevateTo and ElevateMax let a person strengthen this permission for a
	// while (`elevate-to`, `elevate-max`): for at most ElevateMax at a time,
	// the one it is given to has the permission named ElevateTo instead.
	// Both are written or neither is; "" and 0 mean it cannot be strengthened.
	// The settings only allow it: `kisui serve` keeps who is strengthened
	// until when, in memory (server/dbelevate.go).
	ElevateTo  string
	ElevateMax time.Duration
}

// DBAccess is what one actor may do on one connection, after the settings
// are put together (DBConnection.Access).
type DBAccess struct {
	Actor DBActor
	// Permission is the name of the permission in use, "" when the settings
	// name none for this actor.
	Permission string
	Run        DBRun
	// Propose is false for a person: the input is theirs anyway.
	Propose bool
	// User is the database user this actor logs in as.
	User string
	// AgentUser is true when User is the agent's own user, not the user of
	// the connection.
	AgentUser bool
}

// Access is what actor may do on c, a connection as LoadDB gives it.
//
//   - A person with no permission named does what `read-only` says: read
//     when it is true, free otherwise.
//   - An agent with no permission named runs nothing, and may write into
//     the input.
//   - `read-only = true` holds for everybody: with it, nobody is above
//     DBRunRead, whatever their permission says. So a connection that was
//     read-only cannot become writable by naming a permission.
//
// It is the one place that decides. server/db.go asks it for every request;
// while a permission is strengthened for a time, it asks the connection
// Elevated gives instead.
func (c DBConnection) Access(actor DBActor) DBAccess {
	a := DBAccess{Actor: actor, User: c.User}
	switch actor {
	case DBAgent:
		a.Run, a.Propose = DBRunNone, true
		if p := c.Agent; p.Name != "" {
			a.Permission, a.Run, a.Propose = p.Name, p.Run, p.Propose
			if p.AgentUser != "" && p.AgentUser != c.User {
				a.User, a.AgentUser = p.AgentUser, true
			}
		}
	case DBHuman:
		a.Run = DBRunFree
		if p := c.Human; p.Name != "" {
			a.Permission, a.Run = p.Name, p.Run
		}
	default:
		// Nobody we know: nothing is allowed.
		a.Run = DBRunNone
		return a
	}
	if c.ReadOnly && a.Run == DBRunFree {
		a.Run = DBRunRead
	}
	return a
}

// ElevateTarget is the permission actor has on c while its permission is
// strengthened: the one its permission names with `elevate-to`. ok is false
// when the permission of actor cannot be strengthened (none is named, or it
// does not write `elevate-to`).
func (c DBConnection) ElevateTarget(actor DBActor) (target DBPermission, ok bool) {
	switch actor {
	case DBHuman:
		target = c.HumanElevate
	case DBAgent:
		target = c.AgentElevate
	}
	return target, target.Name != ""
}

// Elevated is c with the permission of actor replaced by the one it is
// strengthened to. The result cannot be strengthened again: a time of
// strengthening never leads further than one `elevate-to`. Everything else
// stays, `read-only` too, so Access of the result still keeps a read-only
// connection at DBRunRead. ok is false (and c comes back as it is) when the
// permission of actor cannot be strengthened.
func (c DBConnection) Elevated(actor DBActor) (_ DBConnection, ok bool) {
	target, ok := c.ElevateTarget(actor)
	if !ok {
		return c, false
	}
	// The target's own elevate-to is not followed.
	target.ElevateTo, target.ElevateMax = "", 0
	switch actor {
	case DBHuman:
		c.Human, c.HumanElevate = target, DBPermission{}
	case DBAgent:
		c.Agent, c.AgentElevate = target, DBPermission{}
	}
	return c, true
}

// ParseDBDuration reads a length of time as `elevate-max` writes it and as
// the window sends it when a person strengthens a permission: whole numbers,
// each followed by h, m or s, in that order and each unit at most once
// ("30m", "1h", "1h30m", "90s", "1h5s"). It must be more than zero. There
// are no fractions, no signs and no spaces, and "1h1h" or "30m1h" is not a
// time, so that what is written is what is meant.
func ParseDBDuration(s string) (time.Duration, bool) {
	units := []struct {
		letter byte
		length time.Duration
	}{{'h', time.Hour}, {'m', time.Minute}, {'s', time.Second}}
	var total time.Duration
	// next is the first unit that may still come.
	next := 0
	for s != "" {
		i := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		// At most 6 digits, and each unit at most once: the sum cannot
		// overflow, and nobody means more.
		if i == 0 || i > 6 || i == len(s) {
			return 0, false
		}
		n := 0
		for _, d := range s[:i] {
			n = n*10 + int(d-'0')
		}
		u := next
		for u < len(units) && units[u].letter != s[i] {
			u++
		}
		if u == len(units) {
			return 0, false
		}
		total += time.Duration(n) * units[u].length
		next = u + 1
		s = s[i+1:]
	}
	return total, total > 0
}

// Permission is the permission the settings name for actor on c (the zero
// value when none is named).
func (c DBConnection) Permission(actor DBActor) DBPermission {
	switch actor {
	case DBHuman:
		return c.Human
	case DBAgent:
		return c.Agent
	}
	return DBPermission{}
}

// DBLogin is one way to log in to a connection: where the database is, the
// user that logs in, and whether the login only reads. DBConnection.Login
// makes it from what an actor may do, and internal/db logs in with it. It is
// a type apart from DBConnection because User and ReadOnly mean other things
// there (the user written for the connection; the limit for everybody), so
// that the settings are never logged in with as they are.
type DBLogin struct {
	// Name and Variant are those of the connection.
	Name, Variant string
	Kind          string
	Host          string
	Port          int
	// User is the database user that logs in.
	User string
	// Database may be "", as in DBConnection.
	Database string
	// ReadOnly makes every statement of this login run in a read-only
	// transaction.
	ReadOnly bool
	// TLS and TLSCA are those of the connection.
	TLS, TLSCA string
	// AgentUser is true when User is the agent's own user (the `agent-user`
	// of its permission), not the user written for the connection. The
	// password of such a login is looked for apart from the password of the
	// connection (internal/db).
	AgentUser bool
}

// Login is c as a logs in to it: with the user of a, and read-only unless a
// may run freely. A login that only lists the schema uses it too, so a
// level that runs nothing still logs in read-only.
//
// The agent's own user opens the database the connection's user opens. A
// PostgreSQL connection that writes no `database` opens the one named like
// its user; with the user changed that would be another database, so the
// name is filled in here.
func (c DBConnection) Login(a DBAccess) DBLogin {
	l := DBLogin{
		Name: c.Name, Variant: c.Variant, Kind: c.Kind, Host: c.Host, Port: c.Port,
		User: a.User, Database: c.Database,
		ReadOnly: a.Run != DBRunFree, AgentUser: a.AgentUser,
		TLS: c.TLS, TLSCA: c.TLSCA,
	}
	if a.AgentUser && c.Kind == DBPostgres && c.Database == "" {
		l.Database = c.User
	}
	return l
}

// dbPermissions are the entries of [db.permissions] in use, by name. broken
// holds the names of the entries with a mistake: a connection that names one
// is left out, as one that names a permission nobody wrote.
type dbPermissions struct {
	byName map[string]DBPermission
	broken map[string]bool
}

// dbPermissionKeys are the keys of a [db.permissions.<name>] entry.
var dbPermissionKeys = []string{"run", "propose", "agent-user", "elevate-to", "elevate-max"}

// readDBPermissions reads the value of `db.permissions` of the file at path.
func readDBPermissions(v any, path string) (perms dbPermissions, probs []Problem) {
	t, ok := v.(map[string]any)
	if !ok {
		return perms, []Problem{{File: path, Key: "db.permissions", Code: "config.err.table"}}
	}
	perms.byName, perms.broken = map[string]DBPermission{}, map[string]bool{}
	for _, name := range slices.Sorted(maps.Keys(t)) {
		p, ps := dbPermission(name, t[name])
		for _, e := range ps {
			key := "db.permissions." + name
			if e.Key != "" {
				key += "." + e.Key
			}
			probs = append(probs, Problem{File: path, Key: key, Code: e.Code, Args: e.Args})
		}
		if len(ps) > 0 {
			perms.broken[name] = true
			continue
		}
		perms.byName[name] = p
	}
	return perms, append(probs, perms.checkElevateTargets(path)...)
}

// checkElevateTargets checks the `elevate-to` of every permission, which can
// only be done when all are read: it names another permission. A permission
// whose `elevate-to` cannot be used (it names itself, nobody, or a permission
// with a mistake) becomes one with a mistake itself, so that a connection
// that names it is left out: it would otherwise look as if it could be
// strengthened. Marking one broken can break another that names it, so this
// goes on until nothing changes.
func (perms dbPermissions) checkElevateTargets(path string) (probs []Problem) {
	for changed := true; changed; {
		changed = false
		for _, name := range slices.Sorted(maps.Keys(perms.byName)) {
			to := perms.byName[name].ElevateTo
			if to == "" {
				continue
			}
			code := ""
			switch _, ok := perms.byName[to]; {
			case to == name:
				code = "config.err.elevateself"
			case perms.broken[to]:
				code = "config.err.brokenperm"
			case !ok:
				code = "config.err.noperm"
			}
			if code == "" {
				continue
			}
			probs = append(probs, Problem{File: path, Key: "db.permissions." + name + ".elevate-to", Code: code, Args: []any{to}})
			delete(perms.byName, name)
			perms.broken[name] = true
			changed = true
		}
	}
	return probs
}

// dbPermission reads one [db.permissions.<name>] entry. The Key of a problem
// is the key inside the entry, "" for the entry itself.
func dbPermission(name string, v any) (DBPermission, []Problem) {
	e, ok := v.(map[string]any)
	if !ok {
		return DBPermission{}, []Problem{{Code: "config.err.table"}}
	}
	d := &dbEntry{e: e}
	if strings.TrimSpace(name) == "" {
		d.bad("", "config.err.required")
	}
	for _, key := range slices.Sorted(maps.Keys(e)) {
		if !slices.Contains(dbPermissionKeys, key) {
			d.bad(key, "config.err.unknownperm", strings.Join(dbPermissionKeys, ", "))
		}
	}
	p := DBPermission{Name: name}
	// `run` has no default: a permission says how far it goes.
	if s, ok := d.str("run", true); ok {
		if !slices.Contains(dbRuns, DBRun(s)) {
			names := make([]string, len(dbRuns))
			for i, r := range dbRuns {
				names[i] = string(r)
			}
			d.bad("run", "config.err.oneof", strings.Join(names, ", "))
		} else {
			p.Run = DBRun(s)
		}
	}
	if v, has := e["propose"]; has {
		if b, ok := v.(bool); !ok {
			d.bad("propose", "config.err.bool")
		} else {
			p.Propose = b
		}
	}
	if _, has := e["agent-user"]; has {
		if s, ok := d.str("agent-user", true); ok {
			p.AgentUser = s
		}
	}
	// `elevate-to` and `elevate-max` go together: one without the other
	// would be a permission that looks as if it could be strengthened (or as
	// if it had a limit) and is not.
	_, hasTo := e["elevate-to"]
	_, hasMax := e["elevate-max"]
	if hasTo {
		if s, ok := d.str("elevate-to", true); ok {
			p.ElevateTo = s
		}
		if !hasMax {
			d.bad("elevate-max", "config.err.elevatepair", "elevate-to")
		}
	}
	if hasMax {
		if s, ok := d.str("elevate-max", true); ok {
			if dur, ok := ParseDBDuration(s); ok {
				p.ElevateMax = dur
			} else {
				d.bad("elevate-max", "config.err.duration")
			}
		}
		if !hasTo {
			d.bad("elevate-to", "config.err.elevatepair", "elevate-max")
		}
	}
	return p, d.probs
}

// elevateTarget is the permission p is strengthened to (the zero value when
// p cannot be strengthened). readDBPermissions made sure it is there.
func (perms dbPermissions) elevateTarget(p DBPermission) DBPermission {
	if p.ElevateTo == "" {
		return DBPermission{}
	}
	return perms.byName[p.ElevateTo]
}

// permission reads a key that names a permission (`human-permission`,
// `agent-permission`): nil when it is not written or is wrong (which is
// reported). A name nobody defined is a mistake, not "no permission": the
// connection would otherwise run with other rights than its settings show.
func (d *dbEntry) permission(key string, perms dbPermissions) *DBPermission {
	if _, has := d.e[key]; !has {
		return nil
	}
	s, ok := d.str(key, true)
	if !ok {
		return nil
	}
	if p, ok := perms.byName[s]; ok {
		return &p
	}
	if perms.broken[s] {
		d.bad(key, "config.err.brokenperm", s)
	} else {
		d.bad(key, "config.err.noperm", s)
	}
	return nil
}
