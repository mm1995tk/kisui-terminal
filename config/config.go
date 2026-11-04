// Package config holds the settings only the GUI side (`shj serve`) reads:
// [server]. A UI registers Section with core/config's Options.Sections and
// reads the values with Of.
package config

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/mm1995tk/shijimi-editor/core/config"
)

// Name is the name of Section in config.Config.Value.
const Name = "gui"

// Settings are the GUI's settings of config.toml. They are read only from the
// user's own directory.
type Settings struct {
	// IdleStopDays is how many days `shj serve` waits with no GUI connected
	// before it stops. 0 means it never stops.
	IdleStopDays int
	// StartDir is the folder a new workspace's shell starts in, as an absolute
	// path (a leading ~ is expanded). "" means the home directory.
	StartDir string
}

// Default is the settings of a config that says nothing.
func Default() *Settings { return &Settings{IdleStopDays: 7} }

// Section is what the GUI registers in config.Options.Sections.
var Section = config.Section{
	Name: Name,
	Schema: map[string]config.Field{
		"server": config.Table(map[string]config.Field{
			"idle_stop_days": config.Int.Check(config.NonNegative),
			"start_dir":      config.String.Check(checkStartDir),
		}).UserOnly(),
		// [[gui.machines]] is read by the GUI itself, not by shj. It is listed so
		// shj starts with a config.toml that has it; the GUI reports its own
		// mistakes.
		"gui": config.Table(map[string]config.Field{
			"machines": config.Tables([]string{"ssh"}, map[string]config.Field{"ssh": config.String, "name": config.String}),
		}).UserOnly(),
	},
	New: func() config.Value { return Default() },
}

// Of is the GUI's settings of c: the defaults when c did not read them (a nil
// Config, or one made by hand).
func Of(c *config.Config) *Settings {
	if s, ok := c.Value(Name).(*Settings); ok {
		return s
	}
	s := Default()
	if c != nil {
		c.SetValue(Name, s)
	}
	return s
}

// Merge reads the GUI's keys of a decoded config.toml / config.nix.
func (s *Settings) Merge(raw map[string]any, user bool) {
	if !user {
		return
	}
	t, ok := raw["server"].(map[string]any)
	if !ok {
		return
	}
	if v, ok := t["start_dir"].(string); ok {
		if dir, ok := ExpandStartDir(v); ok {
			s.StartDir = dir
		}
	}
	switch v := t["idle_stop_days"].(type) {
	case int64:
		if v >= 0 {
			s.IdleStopDays = int(v)
		}
	case float64:
		if v >= 0 && v == float64(int(v)) {
			s.IdleStopDays = int(v)
		}
	}
}

// ExpandStartDir turns a [server] start_dir into an absolute path: ~ and ~/x
// are the home directory. ok is false when it is neither that nor an absolute
// path.
func ExpandStartDir(v string) (dir string, ok bool) {
	switch {
	case v == "~" || strings.HasPrefix(v, "~/"):
		home, err := os.UserHomeDir()
		if err != nil {
			return "", false
		}
		return filepath.Join(home, v[1:]), true
	case filepath.IsAbs(v):
		return filepath.Clean(v), true
	}
	return "", false
}

func checkStartDir(v any) (string, []any) {
	s, _ := v.(string)
	dir, ok := ExpandStartDir(s)
	if !ok {
		return "config.err.abspath", nil
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return "config.err.notdir", []any{dir}
	}
	return "", nil
}
