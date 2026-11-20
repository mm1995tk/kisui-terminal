package db

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mm1995tk/kisui-terminal/config"
)

// pgSession is a login to PostgreSQL. It uses pgconn, the low level of pgx,
// and not database/sql: pgconn gives every value in the text form the server
// writes, with no conversion through Go types in between.
type pgSession struct {
	conn     *pgconn.PgConn
	readOnly bool
}

func openPostgres(ctx context.Context, c config.DBConnection, password string) (Session, error) {
	// What a connection's settings say (and sslmode, the timeout and the
	// application name) is written here, so that the environment of kisui
	// serve does not replace it (PGHOST, PGPORT, PGUSER, PGDATABASE,
	// PGSSLMODE, PGCONNECT_TIMEOUT, PGAPPNAME). pgconn still reads the
	// variables for what is not written: PGSERVICE and PGSERVICEFILE,
	// PGOPTIONS, PGTARGETSESSIONATTRS, PGREQUIREAUTH, PGSSLCERT, PGSSLKEY,
	// PGSSLROOTCERT and so on. A PGSERVICE that names a service that is not
	// in the service file makes ParseConfig fail, for every connection.
	// sslmode=prefer is the default of libpq: TLS when
	// the server offers it, without checking the certificate.
	cfg, err := pgconn.ParseConfig(pgKeywords(
		"host", c.Host,
		"port", strconv.Itoa(c.Port),
		"user", c.User,
		"dbname", postgresDatabase(c),
		"sslmode", "prefer",
		"connect_timeout", strconv.Itoa(int(connectTimeout/time.Second)),
		"application_name", "kisui-terminal",
	))
	if err != nil {
		return nil, &Error{Kind: KindConnect, Message: err.Error()}
	}
	// Set after parsing, so that it is the password Passwords found and not
	// one pgconn read from PGPASSWORD or a pgpass file by itself.
	cfg.Password = password
	// Binary values come as \x and hexadecimal digits, whatever the server's
	// default is.
	cfg.RuntimeParams["bytea_output"] = "hex"
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		e := &Error{Kind: KindConnect, Message: err.Error()}
		if pe, ok := errors.AsType[*pgconn.PgError](err); ok {
			e.SQLState = pe.Code
			// invalid_password: a wrong password, or a user that is not there.
			if pe.Code == "28P01" {
				e.Kind = KindAuth
			}
		}
		return nil, e
	}
	return &pgSession{conn: conn, readOnly: c.ReadOnly}, nil
}

// pgKeywords writes a connection string of `keyword='value'` pairs.
func pgKeywords(kv ...string) string {
	var sb strings.Builder
	for i := 0; i+1 < len(kv); i += 2 {
		v := strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(kv[i+1])
		fmt.Fprintf(&sb, "%s='%s' ", kv[i], v)
	}
	return sb.String()
}

func (s *pgSession) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.conn.Close(ctx)
}

// exec runs a statement of our own and throws its rows away.
func (s *pgSession) exec(ctx context.Context, sql string) error {
	_, err := s.conn.ExecParams(ctx, sql, nil, nil, nil, nil).Close()
	return err
}

func (s *pgSession) Query(ctx context.Context, sql string, o QueryOptions) (*Result, error) {
	if isCopy(sql) {
		return nil, &Error{Kind: KindQuery, Message: "COPY is not supported: there is nowhere to send its data to or take it from"}
	}
	given := sql
	sql, err := prepare(config.DBPostgres, sql, o)
	if err != nil {
		return nil, err
	}
	// qctx is ended only by the stopper's hard step (see stopper).
	qctx, hard := context.WithCancel(context.Background())
	defer hard()
	if s.readOnly {
		if err := s.exec(qctx, "BEGIN READ ONLY"); err != nil {
			return nil, pgError(err)
		}
	}
	start := time.Now()
	st := watch(ctx, s.conn.CancelRequest, hard)
	// ExecParams is the extended protocol with no parameters: the server
	// takes one statement only, and with no result formats named every
	// column comes as text.
	rr := s.conn.ExecParams(qctx, sql, nil, nil, nil, nil)
	// pgconn uses the slice again for the next statement.
	fields := append([]pgconn.FieldDescription(nil), rr.FieldDescriptions()...)
	col := newCollector(o, pgColumns(fields), stopFor(s.readOnly, st))
	for rr.NextRow() {
		if col.wants() {
			col.add(pgRow(fields, rr.Values()))
		}
	}
	tag, err := rr.Close()
	col.res.ElapsedMs = elapsedMs(time.Since(start))
	if st.end() {
		// Takes a late request to stop (see stopper.end).
		_ = s.exec(qctx, "SELECT 1")
	}
	if s.readOnly {
		// Nothing was written, so there is nothing to commit. It also clears
		// the failed state that a refused or stopped statement leaves.
		_ = s.exec(qctx, "ROLLBACK")
	}
	if err != nil && !col.stopped {
		return nil, Cancelled(ctx, pgError(err))
	}
	if err == nil && (len(fields) == 0 || tag.Insert() || tag.Update() || tag.Delete() || strings.HasPrefix(tag.String(), "MERGE")) {
		n := tag.RowsAffected()
		col.res.RowsAffected = &n
	}
	if names, ok := s.typeNames(qctx, fields); ok {
		for i := range col.res.Columns {
			col.res.Columns[i].Type = names[i]
		}
	}
	return finish(config.DBPostgres, given, o, col.res), nil
}

// pgColumns describes the columns of a result, with the names of the types
// the server is not needed for (typeNames replaces them).
func pgColumns(fields []pgconn.FieldDescription) []Column {
	cols := make([]Column, len(fields))
	for i, f := range fields {
		cols[i] = Column{Name: f.Name, Type: pgTypeFallback(f.DataTypeOID), Kind: pgKind(f.DataTypeOID)}
	}
	return cols
}

// isCopy is true for a COPY statement. It is refused before it is sent:
// `COPY ... FROM STDIN` makes the server wait for data that nobody sends, so
// the statement would never return, and `COPY ... TO STDOUT` sends its rows
// in a form that is not a result, so they would be lost. COPY to or from a
// file of the server is refused with them; telling it apart needs a parser.
func isCopy(sql string) bool {
	return strings.EqualFold(firstWord(sql), "copy")
}

// firstWord is the first word of a statement, after white space and
// comments (`-- ...` and `/* ... */`, which PostgreSQL lets nest).
func firstWord(sql string) string {
	for {
		sql = strings.TrimLeft(sql, " \t\r\n\f")
		switch {
		case strings.HasPrefix(sql, "--"):
			_, sql, _ = strings.Cut(sql, "\n")
		case strings.HasPrefix(sql, "/*"):
			depth, i := 1, 2
			for ; depth > 0 && i < len(sql); i++ {
				switch {
				case strings.HasPrefix(sql[i:], "/*"):
					depth++
					i++
				case strings.HasPrefix(sql[i:], "*/"):
					depth--
					i++
				}
			}
			sql = sql[i:]
		default:
			end := strings.IndexFunc(sql, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' })
			if end < 0 {
				return sql
			}
			return sql[:end]
		}
	}
}

// typeNames asks the server for the SQL names of the column types
// ("character varying(20)", "text[]", the name of an enum), which only it
// knows. ok is false when it cannot be asked; the columns then keep
// pgTypeFallback.
func (s *pgSession) typeNames(ctx context.Context, fields []pgconn.FieldDescription) (names []string, ok bool) {
	if len(fields) == 0 || s.conn.IsClosed() {
		return nil, false
	}
	var sb strings.Builder
	sb.WriteString("SELECT format_type(o, m) FROM (VALUES ")
	for i, f := range fields {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "(%d, %d::oid, %d)", i, f.DataTypeOID, f.TypeModifier)
	}
	sb.WriteString(") AS v(i, o, m) ORDER BY i")
	rr := s.conn.ExecParams(ctx, sb.String(), nil, nil, nil, nil)
	for rr.NextRow() {
		names = append(names, string(rr.Values()[0]))
	}
	if _, err := rr.Close(); err != nil || len(names) != len(fields) {
		return nil, false
	}
	return names, true
}

// The OIDs of the built-in types that are not KindText.
const (
	pgBool    = 16
	pgBytea   = 17
	pgInt8    = 20
	pgInt2    = 21
	pgInt4    = 23
	pgOID     = 26
	pgFloat4  = 700
	pgFloat8  = 701
	pgNumeric = 1700
)

func pgKind(oid uint32) ColumnKind {
	switch oid {
	case pgBool:
		return KindBoolean
	case pgBytea:
		return KindBinary
	case pgInt8, pgInt2, pgInt4, pgOID, pgFloat4, pgFloat8, pgNumeric:
		return KindNumber
	}
	return KindText
}

// pgTypeFallback names a type when the server could not be asked.
func pgTypeFallback(oid uint32) string {
	switch oid {
	case pgBool:
		return "boolean"
	case pgBytea:
		return "bytea"
	case pgInt8:
		return "bigint"
	case pgInt2:
		return "smallint"
	case pgInt4:
		return "integer"
	case pgFloat4:
		return "real"
	case pgFloat8:
		return "double precision"
	case pgNumeric:
		return "numeric"
	case 25:
		return "text"
	}
	return fmt.Sprintf("oid %d", oid)
}

// pgRow turns the values of a row (text, valid until the next row) into
// cells.
func pgRow(fields []pgconn.FieldDescription, values [][]byte) []*string {
	row := make([]*string, len(values))
	for i, v := range values {
		if v == nil {
			continue
		}
		s := strings.ToValidUTF8(string(v), replacement)
		switch fields[i].DataTypeOID {
		case pgBool:
			switch s {
			case "t":
				s = "true"
			case "f":
				s = "false"
			}
		case pgBytea:
			if rest, ok := strings.CutPrefix(s, `\x`); ok {
				s = "0x" + rest
			}
		}
		row[i] = &s
	}
	return row
}

// pgError turns a failure of a statement into an *Error with the server's
// words: the message, and its DETAIL and HINT when it gave them.
func pgError(err error) *Error {
	pe, ok := errors.AsType[*pgconn.PgError](err)
	if !ok {
		return &Error{Kind: KindQuery, Message: err.Error()}
	}
	msg := pe.Severity + ": " + pe.Message
	if pe.Detail != "" {
		msg += "\nDETAIL: " + pe.Detail
	}
	if pe.Hint != "" {
		msg += "\nHINT: " + pe.Hint
	}
	return &Error{Kind: KindQuery, SQLState: pe.Code, Message: msg}
}
