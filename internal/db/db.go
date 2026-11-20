// Package db connects `kisui serve` to the databases of the user (MySQL and
// PostgreSQL) and runs SQL on them. It knows nothing of the protocol the
// window speaks (server/db.go does that) and nothing of the settings files
// (config.LoadDB reads [[db.connections]]).
//
// The parts:
//
//   - Passwords finds the password of a connection (password.go).
//   - Open logs in and gives a Session; Session.Query runs one statement and
//     gives a Result (postgres.go, mysql.go).
//
// A Session is one login of its own, used for a short while and closed. There
// is no pool: what a statement leaves behind in a session (SET, USE, an open
// transaction, a temporary table) must never reach the next statement of
// another tab, and a login nobody uses must not stay open on a production
// database.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/mm1995tk/kisui-terminal/config"
)

// Session is one login to a database. It is not safe for concurrent use.
type Session interface {
	// Query runs one statement and reads its result. sql is sent as it is,
	// with no parameters, and must be one statement: the database refuses
	// several statements in one request.
	//
	// When ctx ends, the database is told to stop the statement and Query
	// returns an *Error of kind KindCancelled.
	//
	// When the session is read-only (config.DBConnection.ReadOnly), the
	// statement runs in a read-only transaction that is rolled back.
	Query(ctx context.Context, sql string, o QueryOptions) (*Result, error)
	// Close logs out. It is safe to call twice.
	Close()
}

// QueryOptions are the limits of one Query.
type QueryOptions struct {
	// MaxRows is the most rows Result.Rows holds. 0 means DefaultMaxRows;
	// more than MaxMaxRows means MaxMaxRows.
	MaxRows int
}

// The limits of a result. A result goes to the window as one JSON-RPC
// message, so it must stay well under the size of one (rpc.DefaultMaxLine,
// 64 MiB) and small enough for the window to show.
const (
	DefaultMaxRows = 1000
	MaxMaxRows     = 10000
	// maxResultBytes is the most text Result.Rows holds; rows after that are
	// left out like rows after MaxRows.
	maxResultBytes = 8 << 20
	// maxCellBytes is the most text one cell holds; the rest is cut.
	maxCellBytes = 1 << 20
)

func (o QueryOptions) maxRows() int {
	switch {
	case o.MaxRows <= 0:
		return DefaultMaxRows
	case o.MaxRows > MaxMaxRows:
		return MaxMaxRows
	}
	return o.MaxRows
}

// Result is what one statement gave. Its JSON form is the result of the
// request db.query (docs/design/gui-protocol.md).
type Result struct {
	// Columns is empty for a statement that gives no rows (UPDATE, CREATE).
	Columns []Column `json:"columns"`
	// Rows holds each cell as the text the database writes for it (what psql
	// and mysql print), or nil for NULL. Numbers are text too, so that a
	// bigint or a decimal loses no digits on the way to the window. The two
	// exceptions, so that both databases look the same: a PostgreSQL boolean
	// is "true" or "false", and a binary value is "0x" and hexadecimal digits.
	Rows [][]*string `json:"rows"`
	// RowCount is len(Rows).
	RowCount int `json:"rowCount"`
	// Truncated is true when the statement gave more rows than Rows holds.
	Truncated bool `json:"truncated"`
	// TruncatedCells is true when a cell was longer than the limit and cut.
	TruncatedCells bool `json:"truncatedCells,omitempty"`
	// RowsAffected is how many rows the statement changed. nil for a
	// statement that only reads.
	RowsAffected *int64 `json:"rowsAffected,omitempty"`
	// ElapsedMs is how long the statement took, from sending it to reading
	// its last row, in milliseconds. Logging in is not counted.
	ElapsedMs float64 `json:"elapsedMs"`
}

// Column is one column of a Result.
type Column struct {
	Name string `json:"name"`
	// Type is the type as the database names it, in lower case: "integer",
	// "character varying(20)", "text[]" (PostgreSQL), "int unsigned",
	// "varchar" (MySQL). It is for showing, not for telling types apart.
	Type string `json:"type"`
	// Kind tells how to read the text of the cells.
	Kind ColumnKind `json:"kind"`
}

// ColumnKind is the coarse sort of a column, the same for both databases.
type ColumnKind string

const (
	// KindNumber: the text is a number (an integer, a decimal or a float;
	// PostgreSQL can also write NaN, Infinity and -Infinity).
	KindNumber ColumnKind = "number"
	// KindBoolean: the text is "true" or "false". Only PostgreSQL has it.
	KindBoolean ColumnKind = "boolean"
	// KindBinary: the text is "0x" and hexadecimal digits.
	KindBinary ColumnKind = "binary"
	// KindText: everything else (strings, dates, JSON, arrays, ...).
	KindText ColumnKind = "text"
)

// ErrorKind tells where an Error came from.
type ErrorKind string

const (
	// KindConnect: the database could not be reached or refused the login
	// for a reason other than the password.
	KindConnect ErrorKind = "connect"
	// KindAuth: the database refused the user or the password.
	KindAuth ErrorKind = "auth"
	// KindQuery: the database refused or failed the statement.
	KindQuery ErrorKind = "query"
	// KindCancelled: the statement was stopped because its context ended.
	KindCancelled ErrorKind = "cancelled"
)

// Error is a failure of Open or Query.
type Error struct {
	Kind ErrorKind
	// SQLState is the five characters the database gave, or "".
	SQLState string
	// Message is the database's own words. It is not translated.
	Message string
}

func (e *Error) Error() string { return e.Message }

// connectTimeout is how long logging in may take.
const connectTimeout = 10 * time.Second

// Open logs in to c with password. The error is an *Error: of kind KindAuth
// when the database refused the user or the password, else KindConnect.
func Open(ctx context.Context, c config.DBConnection, password string) (Session, error) {
	switch c.Kind {
	case config.DBPostgres:
		return openPostgres(ctx, c, password)
	case config.DBMySQL:
		return openMySQL(ctx, c, password)
	}
	return nil, &Error{Kind: KindConnect, Message: fmt.Sprintf("unknown kind of database: %q", c.Kind)}
}

// collector gathers the rows of one result up to the limits, and decides
// what happens to the statement when the result is full.
type collector struct {
	max   int
	bytes int
	res   *Result
	// stop stops the statement. It is called once, when the result is full,
	// and only for a read-only session: there, nothing is lost by stopping.
	// Otherwise the rest of the rows is read and thrown away, because
	// stopping an `UPDATE ... RETURNING` halfway would undo the update while
	// the window shows its first rows.
	stop    func()
	stopped bool
}

// newCollector makes the collector of one statement. stop is nil for a
// session that is not read-only.
func newCollector(o QueryOptions, cols []Column, stop func()) *collector {
	return &collector{max: o.maxRows(), res: &Result{Columns: cols, Rows: [][]*string{}}, stop: stop}
}

// wants is true when the next row is to be given to add. When the result is
// full it is false: the result is marked truncated, and the statement is
// stopped if that is safe (see stop).
func (c *collector) wants() bool {
	if len(c.res.Rows) < c.max && c.bytes < maxResultBytes {
		return true
	}
	c.res.Truncated = true
	if c.stop != nil && !c.stopped {
		c.stopped = true
		c.stop()
	}
	return false
}

// add keeps one row; the caller has asked wants. The cells are already
// text.
func (c *collector) add(row []*string) {
	for _, cell := range row {
		if cell == nil {
			continue
		}
		if len(*cell) > maxCellBytes {
			cut := cutUTF8(*cell, maxCellBytes)
			*cell = cut
			c.res.TruncatedCells = true
		}
		c.bytes += len(*cell)
	}
	c.res.Rows = append(c.res.Rows, row)
	c.res.RowCount = len(c.res.Rows)
}

// stopFor is the stop of newCollector for a session: st.stop when the
// session is read-only, nil otherwise.
func stopFor(readOnly bool, st *stopper) func() {
	if readOnly {
		return st.stop
	}
	return nil
}

// errCancelled is the error of a statement that was stopped because its
// context ended.
func errCancelled() *Error {
	return &Error{Kind: KindCancelled, Message: "the statement was cancelled"}
}

// Cancelled gives err as cancelled when ctx has ended: whatever a login or
// a statement failed with then, the reason is that it was called off.
func Cancelled(ctx context.Context, err *Error) *Error {
	if ctx.Err() != nil {
		return errCancelled()
	}
	return err
}

// cutUTF8 is the first max bytes of s, shortened so as not to end in the
// middle of a character.
func cutUTF8(s string, max int) string {
	for max > 0 && max < len(s) && s[max]&0xC0 == 0x80 {
		max--
	}
	return s[:max]
}

func elapsedMs(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// replacement stands for the bytes of a value that are not valid UTF-8 (the
// Unicode replacement character).
const replacement = "\uFFFD"
