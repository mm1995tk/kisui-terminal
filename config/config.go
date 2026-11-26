// Package config reads the settings of kisui from its own configuration
// directory, `~/.config/kisui-terminal/` (`kisui-terminal-nightly/` for a
// nightly kisui), from the files listed in files. kisui reads only its own
// keys: [server] and ui-language (Load), and [[db.connections]] (LoadDB, in
// db.go). The window reads [[gui.machines]] from the same files in the same
// order (app/src-tauri/src/config.rs), and [server] start_dir and shell too,
// to pass them to `kisui serve` with each new terminal. What the window
// writes goes to config.local.toml, never to config.toml, so that config.toml
// can be a read-only file (such as the one home-manager makes). The settings
// of shj (`~/.config/shijimi-editor/`) are not read.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// Settings are kisui's settings.
type Settings struct {
	// IdleStopDays is how many days `kisui serve` waits with no GUI connected
	// before it stops. 0 means it never stops.
	IdleStopDays int
	// StartDir is the folder a new workspace's shell starts in, as an absolute
	// path (a leading ~ is expanded). "" means the home directory.
	StartDir string
	// Shell is the shell a new terminal runs, as an absolute path (a leading
	// ~ is expanded). "" means $SHELL. The file may be missing or not
	// runnable: Load does not look (see ShellPath).
	Shell string
	// PaneReach is which panes of this machine a command in a pane (kisui pane
	// send, keys, read, close, list) reaches: PaneReachOwn (the pane itself and
	// the panes opened from it) or PaneReachAll (every pane of this machine).
	PaneReach string
	// UILanguage is the language of kisui's own messages: "en" or "ja".
	UILanguage string
}

// Default is the settings of a config that says nothing.
// The values of [server] pane_reach.
const (
	PaneReachOwn = "own"
	PaneReachAll = "all"
)

func Default() *Settings {
	return &Settings{IdleStopDays: 7, UILanguage: i18n.Default, PaneReach: PaneReachOwn}
}

// Problem is one mistake in a file.
type Problem struct {
	File string // path of the file
	Line int    // line in File; 0 when unknown
	Key  string // the setting, such as "server.start_dir"; empty for the file as a whole
	Code string // i18n key of the reason
	Args []any  // its format arguments
}

// Text is "file:line: key: reason" (the line and the key are left out when
// unknown), in the selected language.
func (p Problem) Text() string {
	var sb strings.Builder
	sb.WriteString(p.File)
	if p.Line > 0 {
		fmt.Fprintf(&sb, ":%d", p.Line)
	}
	sb.WriteString(": ")
	if p.Key != "" {
		sb.WriteString(p.Key)
		sb.WriteString(": ")
	}
	fmt.Fprintf(&sb, i18n.T(p.Code), p.Args...)
	return sb.String()
}

// Error is every mistake Load found.
type Error struct{ Problems []Problem }

// Error is the problems, one per line, in the selected language.
func (e *Error) Error() string {
	lines := make([]string, len(e.Problems))
	for i, p := range e.Problems {
		lines[i] = p.Text()
	}
	return strings.Join(lines, "\n")
}

// dirOf is the user's configuration directory called name under
// $XDG_CONFIG_HOME (or ~/.config): `<name>`, or `<name><suffix>` for a channel
// (see buildinfo.Suffix). A channel that has no directory of its own reads
// `<name>`, so that trying the nightly needs no copying of the settings. ok
// is false when there is no home directory.
func dirOf(name, suffix string) (dir string, ok bool) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(base) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", false
		}
		base = filepath.Join(home, ".config")
	}
	d := filepath.Join(base, name+suffix)
	if suffix != "" {
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			return filepath.Join(base, name), true
		}
	}
	return d, true
}

// UserDir is kisui-terminal's own configuration directory: `kisui-terminal`,
// or `kisui-terminal<suffix>` for a channel when that exists.
func UserDir(suffix string) (dir string, ok bool) { return dirOf("kisui-terminal", suffix) }

// files are the settings files of a directory, in the order they are
// applied: config.toml, then config.local.toml on top of it. A key in
// config.local.toml wins over the same key in config.toml; the keys of a
// table such as [server] are taken one by one. Either file may be missing.
var files = []string{"config.toml", localFile}

// localFile is the file that is read on top of config.toml, and the only one
// kisui-terminal writes.
const localFile = "config.local.toml"

// Load reads kisui's settings from kisui-terminal's configuration directory
// (UserDir), applying files in their order. The Settings are returned even
// with an error, with what did read, so that the language of the messages is
// the user's.
func Load(suffix string) (*Settings, error) {
	s := Default()
	dir, ok := UserDir(suffix)
	if !ok {
		return s, nil
	}
	var probs []Problem
	for _, name := range files {
		path := filepath.Join(dir, name)
		raw, ps, found := readTOML(path)
		probs = append(probs, ps...)
		if found {
			probs = append(probs, s.merge(raw, path)...)
		}
	}
	if len(probs) > 0 {
		return s, &Error{Problems: probs}
	}
	return s, nil
}

// merge applies a decoded file and reports the mistakes in kisui's keys.
func (s *Settings) merge(raw map[string]any, path string) []Problem {
	var probs []Problem
	bad := func(key, code string, args ...any) {
		probs = append(probs, Problem{File: path, Key: key, Code: code, Args: args})
	}
	if v, ok := raw["ui-language"]; ok {
		if lang, ok := v.(string); !ok {
			bad("ui-language", "config.err.string")
		} else if !i18n.Valid(lang) {
			bad("ui-language", "config.err.oneof", i18n.English+", "+i18n.Japanese)
		} else {
			s.UILanguage = lang
		}
	}
	srv, ok := raw["server"]
	if !ok {
		return probs
	}
	t, ok := srv.(map[string]any)
	if !ok {
		bad("server", "config.err.table")
		return probs
	}
	if v, ok := t["idle_stop_days"]; ok {
		if n, ok := integer(v); !ok {
			bad("server.idle_stop_days", "config.err.int")
		} else if n < 0 {
			bad("server.idle_stop_days", "config.err.nonneg")
		} else {
			s.IdleStopDays = int(n)
		}
	}
	if v, ok := t["start_dir"]; ok {
		str, ok := v.(string)
		if !ok {
			bad("server.start_dir", "config.err.string")
		} else if dir, ok := ExpandHome(str); !ok {
			bad("server.start_dir", "config.err.abspath")
		} else if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			bad("server.start_dir", "config.err.notdir", dir)
		} else {
			s.StartDir = dir
		}
	}
	if v, ok := t["shell"]; ok {
		if str, ok := v.(string); !ok {
			bad("server.shell", "config.err.string")
		} else if sh, code := ShellPath(str); code == "config.err.abspath" {
			bad("server.shell", code)
		} else {
			// A file that is missing or cannot be run is not a mistake of
			// the file: `kisui serve` must still start (it warns and runs
			// $SHELL instead, each time it starts a terminal).
			s.Shell = sh
		}
	}
	if v, ok := t["pane_reach"]; ok {
		if str, ok := v.(string); !ok {
			bad("server.pane_reach", "config.err.string")
		} else if str != PaneReachOwn && str != PaneReachAll {
			bad("server.pane_reach", "config.err.oneof", PaneReachOwn+", "+PaneReachAll)
		} else {
			s.PaneReach = str
		}
	}
	return probs
}

// ShellPath turns a shell of the settings ([server] shell, or the shell the
// window passes for a machine) into the absolute path of the file to run: ~/x
// is under the home directory of this machine. The value is the path alone;
// it carries no arguments. code is the i18n key of the reason when it cannot
// be used ("" when it can): "config.err.abspath" when it is not an absolute
// path, or "notexec" (not an i18n key: no message of the settings uses it)
// when it is not a file that can be run. path is what was looked at.
func ShellPath(v string) (path, code string) {
	p, ok := ExpandHome(v)
	if !ok || p == "" {
		return v, "config.err.abspath"
	}
	if fi, err := os.Stat(p); err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o111 == 0 {
		return p, "notexec"
	}
	return p, ""
}

// integer is v as an integer: TOML decodes one as int64. A float64 with
// nothing after the point (such as 3.0) is taken too: earlier versions took
// it (for config.nix, whose numbers come as float64), in config.toml as well,
// and a file written so must keep working.
func integer(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		if n == float64(int64(n)) {
			return int64(n), true
		}
	}
	return 0, false
}

// ExpandHome turns a path of the settings ([server] start_dir and shell, the
// tls-ca of a database connection) into an absolute path: ~ and ~/x
// are the home directory. ok is false when it is neither that nor an
// absolute path.
func ExpandHome(v string) (path string, ok bool) {
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

// readTOML decodes a TOML file. found is false when the file does not exist
// or cannot be decoded; the problems are returned either way.
func readTOML(path string) (raw map[string]any, probs []Problem, found bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, false
		}
		return nil, []Problem{{File: path, Code: "config.err.read", Args: []any{err.Error()}}}, false
	}
	if _, err := toml.Decode(string(data), &raw); err != nil {
		p := Problem{File: path, Code: "config.err.syntax", Args: []any{err.Error()}}
		if pe, ok := errors.AsType[toml.ParseError](err); ok {
			p.Line = pe.Position.Line
			if pe.Message != "" {
				p.Args = []any{pe.Message}
			}
		}
		return nil, []Problem{p}, false
	}
	return raw, nil, true
}
