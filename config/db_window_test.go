package config

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

// The window checks a [[db.connections]] entry before it writes one to
// config.local.toml (app/src-tauri/src/config_db.rs, #486), so that it
// refuses what LoadDB would leave out, for the same reason. Both tests read
// the same cases: an entry without variants, and the problems (key, code and
// the arguments of the message) dbConnection gives for it.
func TestDBConnectionSameAsWindow(t *testing.T) {
	data, err := os.ReadFile("../app/src-tauri/src/config_db_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Entry    string     `json:"entry"`
		Problems [][]string `json:"problems"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		var e map[string]any
		if _, err := toml.Decode(c.Entry, &e); err != nil {
			t.Fatalf("%q: %v", c.Entry, err)
		}
		_, probs := dbConnection(e, dbPermissions{})
		var got []string
		for _, p := range probs {
			parts := []string{p.Key, p.Code}
			for _, a := range p.Args {
				parts = append(parts, fmt.Sprint(a))
			}
			got = append(got, strings.Join(parts, " | "))
		}
		var want []string
		for _, p := range c.Problems {
			want = append(want, strings.Join(p, " | "))
		}
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("%q:\n got %q\nwant %q", c.Entry, got, want)
		}
	}
}
