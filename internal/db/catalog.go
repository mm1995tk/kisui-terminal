package db

import (
	"context"
	"fmt"
	"strings"

	"github.com/mm1995tk/kisui-terminal/config"
)

// Catalog is the schemas of a database, their tables and views, and their
// columns: what the tree beside the SQL shows. Its JSON form is the result of
// the request db.schema (docs/design/gui-protocol.md).
//
// For PostgreSQL it is the schemas of the database the connection logged in
// to. For MySQL a schema is a database, and it is every database the user
// can see. The schemas of the system (pg_catalog, information_schema, pg_*;
// information_schema, mysql, performance_schema, sys) are left out.
type Catalog struct {
	// Schemas are in the order of their names, as the database sorts them.
	// A schema with no tables is there too.
	Schemas []CatalogSchema `json:"schemas"`
	// DefaultSchema is the schema a statement without a schema name uses on
	// this login: PostgreSQL's current_schema() (the first schema of the
	// search_path that exists), MySQL's DATABASE() (the database the
	// connection was made to). It is nil (JSON null, never left out) when
	// there is none: no database named in the MySQL connection, or no schema
	// of the search_path exists. It may be a schema that Schemas does not
	// list (a system schema, or one the user cannot see in MySQL).
	DefaultSchema *string `json:"defaultSchema"`
	// Truncated is true when the database had more columns than the limit
	// (catalogRowLimit, and 8 MiB of text): the schemas and tables after
	// that are missing, and the last table may lack some columns.
	Truncated bool `json:"truncated"`
}

// CatalogSchema is one schema of a Catalog.
type CatalogSchema struct {
	Name string `json:"name"`
	// Tables are in the order of their names.
	Tables []CatalogTable `json:"tables"`
}

// TableKind tells a table from a view.
type TableKind string

const (
	// TableKindTable: a table (in PostgreSQL also a partitioned table and a
	// foreign table).
	TableKindTable TableKind = "table"
	// TableKindView: a view (in PostgreSQL also a materialized view).
	TableKindView TableKind = "view"
)

// CatalogTable is one table or view of a CatalogSchema.
type CatalogTable struct {
	Name string    `json:"name"`
	Kind TableKind `json:"kind"`
	// Columns are in the order of the table.
	Columns []CatalogColumn `json:"columns"`
}

// CatalogColumn is one column of a CatalogTable.
type CatalogColumn struct {
	Name string `json:"name"`
	// Type is the type as the database writes it, unchanged: PostgreSQL's
	// format_type ("character varying(20)", "integer"), MySQL's COLUMN_TYPE
	// ("varchar(20)", "int unsigned", "enum('Active','off')"). It is not
	// changed to lower case, so that the values of an enum and a quoted type
	// name ("\"Mood\"") stay as they are. It is for showing.
	Type string `json:"type"`
}

// catalogRowLimit is the most columns (rows of the catalog query) a Catalog
// holds. One row is a few dozen bytes, so this stays well under the 8 MiB
// of a result.
const catalogRowLimit = 100_000

// The queries of ReadCatalog. Each gives one row per column, with the
// schema, the table, its kind, the column and its type; a table with no
// columns gives one row with NULL for the column, and a schema with no
// tables one row with NULL for the table. The rows are sorted by name (MySQL
// compares the bytes, so that names that differ only in case keep apart).
const (
	pgCatalogSQL = `SELECT n.nspname, c.relname, c.relkind::text, a.attname, format_type(a.atttypid, a.atttypmod)
FROM pg_catalog.pg_namespace n
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
ORDER BY n.nspname, c.relname, a.attnum`
	// The default schema of the login: one row, one column, NULL when none.
	pgDefaultSchemaSQL = `SELECT current_schema()`
	myDefaultSchemaSQL = `SELECT DATABASE()`
	myCatalogSQL       = `SELECT s.SCHEMA_NAME, t.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE
FROM information_schema.SCHEMATA s
LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY CAST(s.SCHEMA_NAME AS BINARY), CAST(t.TABLE_NAME AS BINARY), c.ORDINAL_POSITION`
)

// ReadCatalog lists the schemas, tables and columns of the database s is
// logged in to. kind is the kind of the connection (config.DBPostgres or
// config.DBMySQL). It is two statements on s (the list, then the default
// schema), so its errors are those of Session.Query.
func ReadCatalog(ctx context.Context, s Session, kind string) (*Catalog, error) {
	var sql, defaultSQL string
	var tableKind func(string) TableKind
	switch kind {
	case config.DBPostgres:
		sql, defaultSQL = pgCatalogSQL, pgDefaultSchemaSQL
		tableKind = func(k string) TableKind {
			if k == "v" || k == "m" {
				return TableKindView
			}
			return TableKindTable
		}
	case config.DBMySQL:
		sql, defaultSQL = myCatalogSQL, myDefaultSchemaSQL
		tableKind = func(k string) TableKind {
			if strings.HasSuffix(k, "VIEW") { // VIEW, SYSTEM VIEW
				return TableKindView
			}
			return TableKindTable
		}
	default:
		return nil, &Error{Kind: KindConnect, Message: fmt.Sprintf("unknown kind of database: %q", kind)}
	}
	res, err := s.Query(ctx, sql, QueryOptions{rowLimit: catalogRowLimit})
	if err != nil {
		return nil, err
	}
	cat := catalogOf(res, tableKind)
	// A second statement on the same login, so that it is the default schema
	// of the login the list was read on.
	def, err := s.Query(ctx, defaultSQL, QueryOptions{MaxRows: 1})
	if err != nil {
		return nil, err
	}
	if len(def.Rows) == 1 && len(def.Rows[0]) == 1 && def.Rows[0][0] != nil && *def.Rows[0][0] != "" {
		cat.DefaultSchema = def.Rows[0][0]
	}
	return cat, nil
}

// catalogOf groups the rows of a catalog query (see pgCatalogSQL).
func catalogOf(res *Result, tableKind func(string) TableKind) *Catalog {
	cat := &Catalog{Schemas: []CatalogSchema{}, Truncated: res.Truncated || res.TruncatedCells}
	text := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	// The rows of one schema and of one table come together when sorted, but
	// the groups are found by name so that an order the database chose
	// differently cannot split them.
	schemas := map[string]int{}
	tables := map[[2]string]int{}
	for _, row := range res.Rows {
		if len(row) < 5 || row[0] == nil {
			continue
		}
		schema := *row[0]
		si, ok := schemas[schema]
		if !ok {
			si = len(cat.Schemas)
			schemas[schema] = si
			cat.Schemas = append(cat.Schemas, CatalogSchema{Name: schema, Tables: []CatalogTable{}})
		}
		sc := &cat.Schemas[si]
		if row[1] == nil {
			continue
		}
		key := [2]string{schema, *row[1]}
		ti, ok := tables[key]
		if !ok {
			ti = len(sc.Tables)
			tables[key] = ti
			sc.Tables = append(sc.Tables, CatalogTable{Name: *row[1], Kind: tableKind(text(row[2])), Columns: []CatalogColumn{}})
		}
		if row[3] == nil {
			continue
		}
		tb := &sc.Tables[ti]
		tb.Columns = append(tb.Columns, CatalogColumn{Name: *row[3], Type: text(row[4])})
	}
	return cat
}
