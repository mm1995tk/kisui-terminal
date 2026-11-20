package db

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/mm1995tk/kisui-terminal/config"
)

// Structure is the structure of one table or view: its columns with whether
// they take NULL and their defaults, its indexes and its foreign keys (#379).
// Its JSON form is the result of the request db.structure
// (docs/design/gui-protocol.md).
type Structure struct {
	// Columns are in the order of the table.
	Columns []StructureColumn `json:"columns"`
	// Indexes are the primary key first, then the others in the order of
	// their names. A view has none.
	Indexes []StructureIndex `json:"indexes"`
	// ForeignKeys are the foreign keys of the table (the ones that point
	// from it to another table), in the order of their names.
	ForeignKeys []StructureForeignKey `json:"foreignKeys"`
	// Truncated is true when one of the lists had more rows than the limit
	// (catalogRowLimit) and lacks its last ones.
	Truncated bool `json:"truncated"`
}

// StructureColumn is one column of a Structure.
type StructureColumn struct {
	Name string `json:"name"`
	// Type is written as in CatalogColumn.
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	// Default is the default as the database writes it (PostgreSQL's
	// expression, "nextval('t_id_seq'::regclass)"; MySQL's COLUMN_DEFAULT,
	// where a string is written without its quotes), or nil when there is
	// none.
	Default *string `json:"default"`
}

// StructureIndex is one index of a Structure.
type StructureIndex struct {
	Name string `json:"name"`
	// Columns are the keys of the index in order: a column's name, or the
	// expression of a key that is not a column (PostgreSQL writes it;
	// MySQL's functional key parts are "" here).
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
	// Method is how the index is made, in lower case: "btree", "hash",
	// "gin", "fulltext", ...
	Method string `json:"method"`
}

// StructureForeignKey is one foreign key of a Structure.
type StructureForeignKey struct {
	Name string `json:"name"`
	// Columns are the columns of this table, and RefColumns the ones they
	// point to, in the same order.
	Columns    []string `json:"columns"`
	RefSchema  string   `json:"refSchema"`
	RefTable   string   `json:"refTable"`
	RefColumns []string `json:"refColumns"`
	// OnUpdate and OnDelete are the action, as SQL writes it: "NO ACTION",
	// "RESTRICT", "CASCADE", "SET NULL" or "SET DEFAULT".
	OnUpdate string `json:"onUpdate"`
	OnDelete string `json:"onDelete"`
}

// The queries of ReadStructure. %[1]s and %[2]s are the schema and the table
// as an expression that gives the name (see pgName, myName), and in MySQL's
// %[3]s the alias of the table of information_schema: the names are
// not sent as literals, so that no quote or backslash in them, and no setting
// of the database about backslashes, can change the statement.
const (
	// pgTableOID is the table, as a subquery that gives its oid.
	pgTableOID = `(SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %[1]s AND c.relname = %[2]s AND c.relkind IN ('r', 'p', 'f', 'v', 'm'))`
	// One row per column; a table with no columns gives one row with NULL
	// for the column, and a table that is not there no rows.
	pgColumnsSQL = `SELECT a.attname, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text, pg_get_expr(d.adbin, d.adrelid)
FROM (SELECT ` + pgTableOID + ` AS oid) c
LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE c.oid IS NOT NULL
ORDER BY a.attnum`
	// One row per key of an index. A key that is a column gives the name of
	// the column as it is (pg_get_indexdef would quote it: "userId"), and
	// only a key that is an expression gives the expression. indkey is an
	// int2vector, whose subscripts start at 0.
	pgIndexesSQL = `SELECT i.relname, ix.indisunique::text, ix.indisprimary::text, am.amname,
  COALESCE((SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = ix.indrelid AND a.attnum = ix.indkey[k.n - 1] AND ix.indkey[k.n - 1] <> 0),
    pg_get_indexdef(ix.indexrelid, k.n, true))
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = i.relam
CROSS JOIN LATERAL generate_series(1, ix.indnkeyatts) AS k(n)
WHERE ix.indrelid = ` + pgTableOID + `
ORDER BY ix.indisprimary DESC, i.relname, k.n`
	// One row per column of a foreign key.
	pgForeignKeysSQL = `SELECT con.conname, a.attname, rn.nspname, rc.relname, ra.attname, con.confupdtype::text, con.confdeltype::text
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS k(n)
JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[k.n]
JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[k.n]
WHERE con.contype = 'f' AND con.conrelid = ` + pgTableOID + `
ORDER BY con.conname, k.n`

	// myWhere picks the rows of the table from a table of
	// information_schema. The names are compared as bytes (the same as
	// ReadCatalog tells them apart), and also as text so that MySQL can look
	// only in the one table instead of reading every table of the server.
	myWhere = `%[3]s.TABLE_SCHEMA = %[1]s AND %[3]s.TABLE_NAME = %[2]s
AND CAST(%[3]s.TABLE_SCHEMA AS BINARY) = CAST(%[1]s AS BINARY) AND CAST(%[3]s.TABLE_NAME AS BINARY) = CAST(%[2]s AS BINARY)`
	// One row per column. A MySQL table always has a column, so no rows means
	// there is no such table.
	myColumnsSQL = `SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT
FROM information_schema.COLUMNS c
WHERE ` + myWhere + `
ORDER BY c.ORDINAL_POSITION`
	// One row per key of an index.
	myIndexesSQL = `SELECT s.INDEX_NAME, CAST(s.NON_UNIQUE AS CHAR), s.INDEX_TYPE, s.COLUMN_NAME
FROM information_schema.STATISTICS s
WHERE ` + myWhere + `
ORDER BY s.INDEX_NAME <> 'PRIMARY', CAST(s.INDEX_NAME AS BINARY), s.SEQ_IN_INDEX`
	// One row per column of a foreign key.
	myForeignKeysSQL = `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
WHERE ` + myWhere + ` AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CAST(k.CONSTRAINT_NAME AS BINARY), k.ORDINAL_POSITION`
)

// pgName is a name as a PostgreSQL expression of type text: its UTF-8 bytes
// in hexadecimal, decoded.
func pgName(s string) string {
	return "convert_from(decode('" + hex.EncodeToString([]byte(s)) + "', 'hex'), 'UTF8')"
}

// myName is a name as a MySQL expression: its UTF-8 bytes as a hexadecimal
// literal, read as utf8mb4.
func myName(s string) string {
	if s == "" {
		return "_utf8mb4''"
	}
	return "_utf8mb4 X'" + hex.EncodeToString([]byte(s)) + "'"
}

// pgActions are the codes of pg_constraint.confupdtype and confdeltype.
var pgActions = map[string]string{"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}

// ReadStructure reads the structure of the table (or view) table of the
// schema schema, over s. kind is the kind of the connection. It runs three
// statements on s (columns, indexes, foreign keys). When there is no such
// table it fails with an *Error of kind KindQuery; its other errors are
// those of Session.Query.
func ReadStructure(ctx context.Context, s Session, kind, schema, table string) (*Structure, error) {
	var name func(string) string
	var columns, indexes, fks string
	switch kind {
	case config.DBPostgres:
		name, columns, indexes, fks = pgName, pgColumnsSQL, pgIndexesSQL, pgForeignKeysSQL
	case config.DBMySQL:
		name, columns, indexes, fks = myName, myColumnsSQL, myIndexesSQL, myForeignKeysSQL
	default:
		return nil, &Error{Kind: KindConnect, Message: fmt.Sprintf("unknown kind of database: %q", kind)}
	}
	q := func(sql, alias string) (*Result, error) {
		args := []any{name(schema), name(table)}
		if kind == config.DBMySQL {
			args = append(args, alias) // the table of information_schema in myWhere
		}
		return s.Query(ctx, fmt.Sprintf(sql, args...), QueryOptions{rowLimit: catalogRowLimit})
	}
	st := &Structure{Columns: []StructureColumn{}, Indexes: []StructureIndex{}, ForeignKeys: []StructureForeignKey{}}
	res, err := q(columns, "c")
	if err != nil {
		return nil, err
	}
	if len(res.Rows) == 0 {
		return nil, &Error{Kind: KindQuery, Message: fmt.Sprintf("no such table: %s.%s", schema, table)}
	}
	st.Truncated = st.Truncated || res.Truncated
	for _, row := range res.Rows {
		if len(row) < 4 || row[0] == nil {
			continue
		}
		nullable := text(row[2])
		st.Columns = append(st.Columns, StructureColumn{
			Name: *row[0], Type: text(row[1]),
			// PostgreSQL: "true"; MySQL's IS_NULLABLE: "YES".
			Nullable: nullable == "true" || nullable == "YES",
			Default:  row[3],
		})
	}
	if res, err = q(indexes, "s"); err != nil {
		return nil, err
	}
	st.Truncated = st.Truncated || res.Truncated
	st.Indexes = indexesOf(res, kind)
	if res, err = q(fks, "k"); err != nil {
		return nil, err
	}
	st.Truncated = st.Truncated || res.Truncated
	st.ForeignKeys = foreignKeysOf(res, kind)
	return st, nil
}

// text is the text of a cell, "" for NULL.
func text(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// indexesOf groups the rows of an index query (one row per key; the rows of
// one index come together).
func indexesOf(res *Result, kind string) []StructureIndex {
	out := []StructureIndex{}
	for _, row := range res.Rows {
		if len(row) < 4 || row[0] == nil {
			continue
		}
		var ix StructureIndex
		var col string
		if kind == config.DBPostgres {
			// relname, indisunique, indisprimary, amname, the key
			if len(row) < 5 {
				continue
			}
			ix = StructureIndex{Name: *row[0], Unique: text(row[1]) == "true", Primary: text(row[2]) == "true", Method: strings.ToLower(text(row[3]))}
			col = text(row[4])
		} else {
			// INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME
			ix = StructureIndex{Name: *row[0], Unique: text(row[1]) == "0", Primary: *row[0] == "PRIMARY", Method: strings.ToLower(text(row[2]))}
			col = text(row[3])
		}
		if n := len(out); n > 0 && out[n-1].Name == ix.Name {
			out[n-1].Columns = append(out[n-1].Columns, col)
			continue
		}
		ix.Columns = []string{col}
		out = append(out, ix)
	}
	return out
}

// foreignKeysOf groups the rows of a foreign key query (one row per column;
// the rows of one foreign key come together).
func foreignKeysOf(res *Result, kind string) []StructureForeignKey {
	out := []StructureForeignKey{}
	action := func(s string) string {
		if kind == config.DBPostgres {
			return pgActions[s]
		}
		return s
	}
	for _, row := range res.Rows {
		if len(row) < 7 || row[0] == nil {
			continue
		}
		col, ref := text(row[1]), text(row[4])
		if n := len(out); n > 0 && out[n-1].Name == *row[0] {
			out[n-1].Columns = append(out[n-1].Columns, col)
			out[n-1].RefColumns = append(out[n-1].RefColumns, ref)
			continue
		}
		out = append(out, StructureForeignKey{
			Name: *row[0], Columns: []string{col},
			RefSchema: text(row[2]), RefTable: text(row[3]), RefColumns: []string{ref},
			OnUpdate: action(text(row[5])), OnDelete: action(text(row[6])),
		})
	}
	return out
}
