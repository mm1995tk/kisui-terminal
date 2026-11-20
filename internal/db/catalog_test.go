package db

import (
	"context"
	"reflect"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
)

// findSchema is the schema named name in cat, or nil.
func findSchema(cat *Catalog, name string) *CatalogSchema {
	for i := range cat.Schemas {
		if cat.Schemas[i].Name == name {
			return &cat.Schemas[i]
		}
	}
	return nil
}

// findTable is the table named name in sc, or nil.
func findTable(sc *CatalogSchema, name string) *CatalogTable {
	for i := range sc.Tables {
		if sc.Tables[i].Name == name {
			return &sc.Tables[i]
		}
	}
	return nil
}

func TestCatalog(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		// MySQL's user of the tests may only use the database "kisui", which is
		// its schema; PostgreSQL makes schemas of its own.
		schema, empty := "kisui", ""
		s := open(t, c)
		if c.Kind == config.DBPostgres {
			schema, empty = "cat_full", "cat_empty"
			query(t, s, "DROP SCHEMA IF EXISTS cat_full CASCADE")
			query(t, s, "DROP SCHEMA IF EXISTS cat_empty CASCADE")
			query(t, s, "CREATE SCHEMA cat_full")
			query(t, s, "CREATE SCHEMA cat_empty")
		}
		for _, sql := range []string{
			"DROP VIEW IF EXISTS " + schema + ".cat_v",
			"DROP TABLE IF EXISTS " + schema + ".cat_t",
			"DROP TABLE IF EXISTS " + schema + ".cat_T2",
			"CREATE TABLE " + schema + ".cat_t (id INT, name VARCHAR(20), note TEXT)",
			"CREATE TABLE " + schema + ".cat_T2 (x INT)",
			"CREATE VIEW " + schema + ".cat_v AS SELECT name, id FROM " + schema + ".cat_t",
		} {
			query(t, s, sql)
		}
		cat, err := ReadCatalog(context.Background(), s, c.Kind)
		if err != nil {
			t.Fatal(err)
		}
		if cat.Truncated {
			t.Errorf("truncated")
		}
		for _, sys := range []string{"information_schema", "pg_catalog", "pg_toast", "mysql", "performance_schema", "sys"} {
			if findSchema(cat, sys) != nil {
				t.Errorf("the system schema %s is listed", sys)
			}
		}
		sc := findSchema(cat, schema)
		if sc == nil {
			t.Fatalf("no schema %s: %+v", schema, cat)
		}
		tb := findTable(sc, "cat_t")
		if tb == nil {
			t.Fatalf("no table: %+v", sc)
		}
		want := []CatalogColumn{{"id", "integer"}, {"name", "character varying(20)"}, {"note", "text"}}
		if c.Kind == config.DBMySQL {
			want = []CatalogColumn{{"id", "int"}, {"name", "varchar(20)"}, {"note", "text"}}
		}
		if tb.Kind != TableKindTable || !reflect.DeepEqual(tb.Columns, want) {
			t.Errorf("table: %+v", tb)
		}
		// A name in another case is a table of its own (PostgreSQL folds the
		// unquoted name to lower case; MySQL on Linux keeps it).
		other := "cat_t2"
		if c.Kind == config.DBMySQL {
			other = "cat_T2"
		}
		if tb := findTable(sc, other); tb == nil || len(tb.Columns) != 1 {
			t.Errorf("the second table: %+v", sc.Tables)
		}
		v := findTable(sc, "cat_v")
		if v == nil || v.Kind != TableKindView || len(v.Columns) != 2 || v.Columns[0].Name != "name" {
			t.Errorf("view: %+v", v)
		}
		// The type is as the database writes it: the values of an enum and a
		// quoted type name keep their case.
		enumType, enumTable := "enum('Active','INACTIVE')", schema+".cat_e"
		if c.Kind == config.DBPostgres {
			query(t, s, `CREATE TYPE cat_full."Mood" AS ENUM ('Happy')`)
			query(t, s, `CREATE TABLE cat_full.cat_e (m cat_full."Mood")`)
			enumType = `cat_full."Mood"`
		} else {
			query(t, s, "DROP TABLE IF EXISTS "+enumTable)
			query(t, s, "CREATE TABLE "+enumTable+" (m ENUM('Active','INACTIVE'))")
		}
		cat, err = ReadCatalog(context.Background(), s, c.Kind)
		if err != nil {
			t.Fatal(err)
		}
		if tb := findTable(findSchema(cat, schema), "cat_e"); tb == nil || !reflect.DeepEqual(tb.Columns, []CatalogColumn{{"m", enumType}}) {
			t.Errorf("enum: %+v", tb)
		}
		if empty != "" {
			if e := findSchema(cat, empty); e == nil || len(e.Tables) != 0 {
				t.Errorf("the empty schema: %+v", e)
			}
		}
	})
}

// The catalog is read on a read-only connection too.
func TestCatalogReadOnly(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		c.ReadOnly = true
		cat, err := ReadCatalog(context.Background(), open(t, c), c.Kind)
		if err != nil || len(cat.Schemas) == 0 {
			t.Errorf("%+v, %v", cat, err)
		}
	})
}

// catalogOf keeps the groups apart even when their rows are not together.
func TestCatalogOf(t *testing.T) {
	p := func(s string) *string { return &s }
	res := &Result{Rows: [][]*string{
		{p("a"), p("t"), p("r"), p("x"), p("integer")},
		{p("b"), nil, nil, nil, nil},
		{p("a"), p("v"), p("v"), nil, nil},
		{p("a"), p("t"), p("r"), p("y"), p("text")},
	}, Truncated: true}
	cat := catalogOf(res, func(k string) TableKind {
		if k == "v" {
			return TableKindView
		}
		return TableKindTable
	})
	want := &Catalog{Truncated: true, Schemas: []CatalogSchema{
		{Name: "a", Tables: []CatalogTable{
			{Name: "t", Kind: TableKindTable, Columns: []CatalogColumn{{"x", "integer"}, {"y", "text"}}},
			{Name: "v", Kind: TableKindView, Columns: []CatalogColumn{}},
		}},
		{Name: "b", Tables: []CatalogTable{}},
	}}
	if !reflect.DeepEqual(cat, want) {
		t.Errorf("got  %+v\nwant %+v", cat, want)
	}
}
