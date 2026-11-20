package db

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/mm1995tk/kisui-terminal/config"
)

// TestStructure: ReadStructure gives the columns (with NULL and the
// default), the indexes and the foreign keys of a table, finds a table whose
// name needs quoting, and fails for a table that is not there (#379).
func TestStructure(t *testing.T) {
	both(t, func(t *testing.T, c config.DBLogin) {
		schema := "kisui"
		quote := myQuoteIdent
		if c.Kind == config.DBPostgres {
			schema, quote = "st_s", pgQuoteIdent
		}
		s := open(t, c)
		// A name with both quotes, a backslash, upper case and letters that are not ASCII.
		child := `st "C'\` + "`子`"
		parent := "st_parent"
		qs, qc, qp := quote(schema), quote(child), quote(parent)
		if c.Kind == config.DBPostgres {
			query(t, s, "DROP SCHEMA IF EXISTS st_s CASCADE")
			query(t, s, "CREATE SCHEMA st_s")
		} else {
			query(t, s, "DROP TABLE IF EXISTS "+qs+"."+qc)
			query(t, s, "DROP TABLE IF EXISTS "+qs+"."+qp)
		}
		query(t, s, "CREATE TABLE "+qs+"."+qp+" (a INT NOT NULL, b INT NOT NULL, PRIMARY KEY (a, b))")
		query(t, s, "CREATE TABLE "+qs+"."+qc+` (
  id INT NOT NULL PRIMARY KEY,
  pa INT NOT NULL,
  pb INT NOT NULL,
  note VARCHAR(20) DEFAULT 'x',
  CONSTRAINT st_fk FOREIGN KEY (pa, pb) REFERENCES `+qs+"."+qp+` (a, b) ON DELETE CASCADE
)`)
		query(t, s, "CREATE UNIQUE INDEX st_note ON "+qs+"."+qc+" (note, pb)")

		st, err := ReadStructure(context.Background(), s, c.Kind, schema, child)
		if err != nil {
			t.Fatal(err)
		}
		if st.Truncated {
			t.Errorf("truncated")
		}
		x := "x"
		if c.Kind == config.DBPostgres {
			x = "'x'::character varying"
		}
		intType, varchar := "integer", "character varying(20)"
		if c.Kind == config.DBMySQL {
			intType, varchar = "int", "varchar(20)"
		}
		wantCols := []StructureColumn{
			{Name: "id", Type: intType}, {Name: "pa", Type: intType}, {Name: "pb", Type: intType},
			{Name: "note", Type: varchar, Nullable: true, Default: &x},
		}
		if !reflect.DeepEqual(st.Columns, wantCols) {
			t.Errorf("columns: %+v", st.Columns)
		}
		pk := "st \"C'\\`子`_pkey"
		if c.Kind == config.DBMySQL {
			pk = "PRIMARY"
		}
		wantIx := []StructureIndex{
			{Name: pk, Columns: []string{"id"}, Unique: true, Primary: true, Method: "btree"},
			{Name: "st_note", Columns: []string{"note", "pb"}, Unique: true, Method: "btree"},
		}
		got := st.Indexes
		if c.Kind == config.DBMySQL {
			// MySQL makes an index for the foreign key, named after it.
			if len(got) == 3 && got[1].Name == "st_fk" {
				got = []StructureIndex{got[0], got[2]}
			}
		}
		if !reflect.DeepEqual(got, wantIx) {
			t.Errorf("indexes: %+v", st.Indexes)
		}
		onUpdate := "NO ACTION"
		wantFK := []StructureForeignKey{{
			Name: "st_fk", Columns: []string{"pa", "pb"},
			RefSchema: schema, RefTable: parent, RefColumns: []string{"a", "b"},
			OnUpdate: onUpdate, OnDelete: "CASCADE",
		}}
		if !reflect.DeepEqual(st.ForeignKeys, wantFK) {
			t.Errorf("foreign keys: %+v", st.ForeignKeys)
		}

		// The parent: no foreign keys of its own (the one pointing at it is
		// not its), and the primary key over two columns.
		st, err = ReadStructure(context.Background(), s, c.Kind, schema, parent)
		if err != nil {
			t.Fatal(err)
		}
		if len(st.ForeignKeys) != 0 || len(st.Indexes) != 1 || !reflect.DeepEqual(st.Indexes[0].Columns, []string{"a", "b"}) {
			t.Errorf("parent: %+v", st)
		}

		// A table that is not there, and one whose name differs only in case.
		for _, name := range []string{"st_nothing", "ST_PARENT"} {
			_, err = ReadStructure(context.Background(), s, c.Kind, schema, name)
			if e, ok := errors.AsType[*Error](err); !ok || e.Kind != KindQuery {
				t.Errorf("%s: %v", name, err)
			}
		}
	})
}
