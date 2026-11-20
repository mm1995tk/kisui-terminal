package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/mm1995tk/kisui-terminal/config"
)

// mySession is a login to MySQL (or MariaDB): one connection of
// database/sql, held for the life of the session.
type mySession struct {
	connector driver.Connector
	db        *sql.DB
	conn      *sql.Conn
	id        int64 // CONNECTION_ID(), to stop a statement with KILL QUERY
	readOnly  bool
}

func openMySQL(ctx context.Context, c config.DBConnection, password string) (Session, error) {
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.DBName = c.User, password, c.Database
	if strings.HasPrefix(c.Host, "/") {
		cfg.Net, cfg.Addr = "unix", c.Host
	} else {
		cfg.Net, cfg.Addr = "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
		// TLS when the server offers it, without checking the certificate:
		// what the mysql client does by default, and what sslmode=prefer is
		// for PostgreSQL.
		cfg.TLSConfig = "preferred"
	}
	cfg.Timeout = connectTimeout
	// The driver writes broken connections to stderr by default; they come
	// back as errors anyway.
	cfg.Logger = &mysql.NopLogger{}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, &Error{Kind: KindConnect, Message: err.Error()}
	}
	s := &mySession{connector: connector, db: sql.OpenDB(connector), readOnly: c.ReadOnly}
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	s.conn, err = s.db.Conn(ctx)
	if err == nil {
		err = s.conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&s.id)
	}
	if err != nil {
		s.Close()
		e := myError(err)
		e.Kind = KindConnect
		if me, ok := errors.AsType[*mysql.MySQLError](err); ok && (me.Number == 1045 || me.Number == 1698) {
			// ER_ACCESS_DENIED_ERROR, ER_ACCESS_DENIED_NO_PASSWORD_ERROR
			e.Kind = KindAuth
		}
		return nil, e
	}
	return s, nil
}

func (s *mySession) Close() {
	if s.conn != nil {
		_ = s.conn.Close()
	}
	_ = s.db.Close()
}

// kill asks the server to stop the statement of this session, from a second
// login (the first is busy with the statement).
func (s *mySession) kill(ctx context.Context) error {
	db := sql.OpenDB(s.connector)
	defer db.Close()
	_, err := db.ExecContext(ctx, "KILL QUERY "+strconv.FormatInt(s.id, 10))
	return err
}

func (s *mySession) Query(ctx context.Context, query string, o QueryOptions) (*Result, error) {
	given := query
	query, err := prepare(config.DBMySQL, query, o)
	if err != nil {
		return nil, err
	}
	// qctx is ended only by the stopper's hard step (see stopper).
	qctx, hard := context.WithCancel(context.Background())
	defer hard()
	if s.readOnly {
		if err := s.beginReadOnly(qctx); err != nil {
			return nil, myError(err)
		}
		// Closing the session rolls back too, when this cannot run.
		defer s.conn.ExecContext(qctx, "ROLLBACK") //nolint:errcheck
	}
	start := time.Now()
	st := watch(ctx, s.kill, hard)
	// With no arguments the driver sends the text as it is (COM_QUERY), and
	// the server takes one statement only (multiStatements is off).
	rows, err := s.conn.QueryContext(qctx, query)
	if err != nil {
		s.ended(qctx, st)
		return nil, Cancelled(ctx, myError(err))
	}
	col := newCollector(o, myColumns(rows), stopFor(s.readOnly, st))
	err = myRows(rows, col)
	_ = rows.Close()
	col.res.ElapsedMs = elapsedMs(time.Since(start))
	asked := s.ended(qctx, st)
	if err != nil && !col.stopped {
		return nil, Cancelled(ctx, myError(err))
	}
	// Not after a stop was asked for: the statement run for that (ended) has
	// replaced the count.
	if len(col.res.Columns) == 0 && !asked {
		col.res.RowsAffected = s.rowsAffected(qctx)
	}
	return finish(config.DBMySQL, given, o, col.res), nil
}

// myColumns describes the columns of a result.
func myColumns(rows *sql.Rows) []Column {
	types, _ := rows.ColumnTypes()
	cols := make([]Column, len(types))
	for i, t := range types {
		cols[i] = Column{Name: t.Name(), Type: myTypeName(t.DatabaseTypeName()), Kind: myKind(t.DatabaseTypeName())}
	}
	return cols
}

// myRows reads the rows of a result to its end and gives col the ones it
// wants.
func myRows(rows *sql.Rows, col *collector) error {
	raw := make([]sql.RawBytes, len(col.res.Columns))
	dest := make([]any, len(raw))
	for i := range raw {
		dest[i] = &raw[i]
	}
	for rows.Next() {
		if !col.wants() {
			continue
		}
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		col.add(myRow(col.res.Columns, raw))
	}
	return rows.Err()
}

// myRow turns the values of a row (valid until the next row) into cells.
func myRow(cols []Column, raw []sql.RawBytes) []*string {
	row := make([]*string, len(raw))
	for i, v := range raw {
		if v == nil {
			continue
		}
		var cell string
		if cols[i].Kind == KindBinary {
			cell = "0x" + hex.EncodeToString(v)
		} else {
			cell = strings.ToValidUTF8(string(v), replacement)
		}
		row[i] = &cell
	}
	return row
}

// rowsAffected is how many rows the statement just run changed, nil when it
// was not one that changes rows (ROW_COUNT() is -1 then).
func (s *mySession) rowsAffected(ctx context.Context) *int64 {
	var n int64
	if err := s.conn.QueryRowContext(ctx, "SELECT ROW_COUNT()").Scan(&n); err != nil || n < 0 {
		return nil
	}
	return &n
}

// ended is called when the statement has ended. asked is stopper.end's.
func (s *mySession) ended(ctx context.Context, st *stopper) (asked bool) {
	asked = st.end()
	if asked {
		// Takes a late KILL QUERY (see stopper.end).
		_, _ = s.conn.ExecContext(ctx, "DO 0")
	}
	return asked
}

// beginReadOnly makes the next statement read-only, in two ways, because
// neither is enough alone in MySQL:
//
//   - The session is set to start every transaction read-only. A statement
//     that changes the schema (DROP TABLE) first ends the transaction it is
//     in, so only this refuses it.
//   - A read-only transaction is started. A statement cannot leave it
//     without ending itself, so a write inside a stored procedure is refused
//     even if the procedure changes the setting of the session.
//
// The setting is written before every statement, because the statement
// before could have changed it.
func (s *mySession) beginReadOnly(ctx context.Context) error {
	for _, q := range []string{"SET SESSION TRANSACTION READ ONLY", "START TRANSACTION READ ONLY"} {
		if _, err := s.conn.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// myTypeName turns the driver's name of a type ("UNSIGNED INT") into the way
// MySQL writes it ("int unsigned").
func myTypeName(name string) string {
	name = strings.ToLower(name)
	if rest, ok := strings.CutPrefix(name, "unsigned "); ok {
		return rest + " unsigned"
	}
	return name
}

func myKind(name string) ColumnKind {
	switch strings.TrimPrefix(name, "UNSIGNED ") {
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT", "FLOAT", "DOUBLE", "DECIMAL", "YEAR":
		return KindNumber
	case "BIT", "BINARY", "VARBINARY", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB", "GEOMETRY", "VECTOR":
		return KindBinary
	}
	return KindText
}

// myError turns a failure into an *Error with the server's words, in the
// form the mysql client prints: "Error 1146 (42S02): Table ... doesn't exist".
func myError(err error) *Error {
	e := &Error{Kind: KindQuery, Message: err.Error()}
	if me, ok := errors.AsType[*mysql.MySQLError](err); ok {
		e.SQLState = string(me.SQLState[:])
		if me.SQLState == [5]byte{} {
			e.SQLState = ""
		}
	}
	return e
}
