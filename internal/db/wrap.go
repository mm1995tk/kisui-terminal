package db

import (
	"fmt"
	"strings"

	"github.com/mm1995tk/kisui-terminal/config"
)

// Wrapping a statement (#373): to show the rows of a SELECT after the first
// page, the statement is run again inside another one,
//
//	SELECT * FROM (
//	<the statement>
//	) AS q LIMIT <rows of a page + 1> OFFSET <rows before the page>
//
// because a session is closed after each statement (see the package), so
// there is no cursor to read on from. The database does the skipping, and
// the extra row tells whether there is a page after. The same wrapping is
// where an ORDER BY of a column chosen in the window goes (#377).
//
// Only a SELECT (or a WITH ... SELECT) can be wrapped. A statement is told
// apart by its words, read by a small scanner that knows the comments and
// the quotes of both databases; it does not parse SQL.

// wrapAlias is the name of the wrapped statement in the outer one.
const wrapAlias = "q"

// stmt is what the scanner found in one statement.
type stmt struct {
	// body is the statement up to the end of its last token: without a
	// trailing `;` and the white space and comments around it.
	body string
	// first is the first word after any `(` and comments, in lower case;
	// "" when the statement starts with something else (a quoted name).
	first string
	// multi is true when another statement follows a `;`.
	multi bool
	// modifying is true when INSERT, UPDATE, DELETE or MERGE follows a `(`:
	// a PostgreSQL WITH whose sub statement writes, which may only stand at
	// the top level.
	modifying bool
}

// wrappable is true when sql, which gave the columns cols, can be run again
// wrapped (see wrapSQL). MySQL refuses a derived table with two columns of
// the same name (names are compared without case), which a SELECT * of a
// join often has; PostgreSQL takes it.
func wrappable(kind, sql string, cols []Column) bool {
	if len(cols) == 0 || !scan(kind, sql).canWrap() {
		return false
	}
	if kind == config.DBMySQL {
		seen := make(map[string]bool, len(cols))
		for _, c := range cols {
			k := strings.ToLower(c.Name)
			if seen[k] {
				return false
			}
			seen[k] = true
		}
	}
	return true
}

func (s stmt) canWrap() bool {
	return !s.multi && (s.first == "select" || (s.first == "with" && !s.modifying))
}

// wrapSQL gives sql wrapped to read limit rows after the first offset.
func wrapSQL(kind, sql string, offset, limit int) (string, error) {
	s := scan(kind, sql)
	if !s.canWrap() {
		return "", &Error{Kind: KindQuery, Message: "only a SELECT can be paged"}
	}
	// The line breaks keep a `--` comment at the end of a line of the
	// statement from swallowing the closing parenthesis.
	return fmt.Sprintf("SELECT * FROM (\n%s\n) AS %s LIMIT %d OFFSET %d", s.body, wrapAlias, limit, offset), nil
}

// quoted is the token nextToken gives for a quoted string or name.
const quoted = "\x00"

// scan tells what the statement sql is, from its tokens (nextToken).
func scan(kind, sql string) stmt {
	var s stmt
	end := 0        // the end of the last token that is not `;`
	prev := ""      // the token before
	opening := true // only `(` so far
	semi := false
	for i := 0; ; {
		tok, next, ok := nextToken(kind, sql, i)
		if !ok {
			break
		}
		i = next
		if tok == ";" {
			semi = true
			continue
		}
		if semi {
			s.multi = true
		}
		if opening && tok != "(" {
			opening = false
			if tok != quoted && isWordByte(tok[0]) {
				s.first = tok
			}
		}
		if prev == "(" && (tok == "insert" || tok == "update" || tok == "delete" || tok == "merge") {
			s.modifying = true
		}
		prev = tok
		end = i
	}
	s.body = sql[:end]
	return s
}

// nextToken reads the token of sql at or after i, as the database kind
// would split it, skipping white space and comments. tok is a word in lower
// case, quoted for a quoted string or name, or else one character; next is
// the index after it. ok is false when only white space and comments are
// left.
//
// The comments: `--` to the end of the line (MySQL wants white space after
// it), `#` to the end of the line (MySQL), `/* */` (PostgreSQL lets them
// nest). The quotes: '...' and "..." with a doubled quote inside (MySQL also
// takes a backslash, and so does a PostgreSQL E'...'), `...` (MySQL) and
// $tag$...$tag$ (PostgreSQL).
func nextToken(kind, sql string, i int) (tok string, next int, ok bool) {
	my := kind == config.DBMySQL
	n := len(sql)
	for i < n {
		c := sql[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
		case c == '-' && i+1 < n && sql[i+1] == '-' && (!my || i+2 == n || sql[i+2] <= ' '),
			c == '#' && my:
			if j := strings.IndexByte(sql[i:], '\n'); j >= 0 {
				i += j + 1
			} else {
				i = n
			}
		case c == '/' && i+1 < n && sql[i+1] == '*':
			i = skipComment(sql, i, !my)
		case c == '\'':
			return quoted, skipQuoted(sql, i, '\'', my), true
		case c == '"':
			return quoted, skipQuoted(sql, i, '"', my), true
		case c == '`' && my:
			return quoted, skipQuoted(sql, i, '`', false), true
		case c == '$' && !my && dollarTag(sql, i) != "":
			tag := dollarTag(sql, i)
			if j := strings.Index(sql[i+len(tag):], tag); j >= 0 {
				return quoted, i + len(tag) + j + len(tag), true
			}
			return quoted, n, true
		case isWordByte(c) && !isDigit(c):
			j := i + 1
			for j < n && (isWordByte(sql[j]) || (!my && sql[j] == '$')) {
				j++
			}
			word := strings.ToLower(sql[i:j])
			// A PostgreSQL E'...' takes a backslash.
			if !my && word == "e" && j < n && sql[j] == '\'' {
				return quoted, skipQuoted(sql, j, '\'', true), true
			}
			return word, j, true
		default:
			return string(c), i + 1, true
		}
	}
	return "", n, false
}

// skipComment is the index after the /* */ comment that starts at i.
func skipComment(sql string, i int, nest bool) int {
	depth := 0
	for i < len(sql) {
		switch {
		case strings.HasPrefix(sql[i:], "/*") && (nest || depth == 0):
			depth++
			i += 2
		case strings.HasPrefix(sql[i:], "*/"):
			depth--
			i += 2
			if depth == 0 {
				return i
			}
		default:
			i++
		}
	}
	return i
}

// skipQuoted is the index after the quoted string or name that starts at i
// with q. A doubled q stands for one; backslash also escapes the next byte.
func skipQuoted(sql string, i int, q byte, backslash bool) int {
	for j := i + 1; j < len(sql); j++ {
		switch {
		case backslash && sql[j] == '\\':
			j++
		case sql[j] == q:
			if j+1 < len(sql) && sql[j+1] == q {
				j++
				continue
			}
			return j + 1
		}
	}
	return len(sql)
}

// dollarTag is the $tag$ that opens a PostgreSQL dollar quote at i, or "".
// `$1` (a parameter) is not one.
func dollarTag(sql string, i int) string {
	j := i + 1
	if j < len(sql) && isDigit(sql[j]) {
		return ""
	}
	for j < len(sql) && isWordByte(sql[j]) {
		j++
	}
	if j < len(sql) && sql[j] == '$' {
		return sql[i : j+1]
	}
	return ""
}

// isWordByte is true for a byte of a word: a letter, a digit, `_`, or a
// byte of a character that is not ASCII.
func isWordByte(c byte) bool {
	return c == '_' || c >= 0x80 || isDigit(c) || (c|0x20 >= 'a' && c|0x20 <= 'z')
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
