// Package config reads the settings of kisui from the configuration files it
// shares with shj: `~/.config/shijimi-editor/config.toml` (and config.nix),
// or `shijimi-editor-nightly/` for a nightly kisui. kisui reads only its own
// keys, [server] and ui-language; the rest is shj's, which checks them
// itself when it starts in a pane. shj knows kisui's keys too, so that it
// does not warn about them (see "Machines in kisui-terminal" and [server] in
// the manual of shijimi-editor).
package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

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
	// UILanguage is the language of kisui's own messages: "en" or "ja".
	UILanguage string
}

// Default is the settings of a config that says nothing.
func Default() *Settings { return &Settings{IdleStopDays: 7, UILanguage: i18n.Default} }

// Problem is one mistake in a file.
type Problem struct {
	File string // path of the file
	Line int    // line in File; 0 when unknown (Nix has no lines)
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
		sb.WriteString(p.Key + ": ")
	}
	sb.WriteString(fmt.Sprintf(i18n.T(p.Code), p.Args...))
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

// UserDir is the user's configuration directory under $XDG_CONFIG_HOME (or
// ~/.config): `shijimi-editor`, or `shijimi-editor<suffix>` for a channel
// (see buildinfo.Suffix). A channel that has no directory of its own reads
// `shijimi-editor`, so that trying the nightly needs no copying of the
// settings. ok is false when there is no home directory.
func UserDir(suffix string) (dir string, ok bool) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if !filepath.IsAbs(base) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", false
		}
		base = filepath.Join(home, ".config")
	}
	d := filepath.Join(base, "shijimi-editor"+suffix)
	if suffix != "" {
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			return filepath.Join(base, "shijimi-editor"), true
		}
	}
	return d, true
}

// Load reads kisui's settings from the user's configuration directory
// (UserDir): config.toml, then config.nix on top of it. The Settings are
// returned even with an error, with what did read, so that the language of
// the messages is the user's.
func Load(suffix string) (*Settings, error) {
	s := Default()
	dir, ok := UserDir(suffix)
	if !ok {
		return s, nil
	}
	var probs []Problem
	for _, f := range []struct {
		name string
		read func(path string) (map[string]any, []Problem, bool)
	}{{"config.toml", readTOML}, {"config.nix", readNix}} {
		path := filepath.Join(dir, f.name)
		raw, ps, found := f.read(path)
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
		} else if dir, ok := ExpandStartDir(str); !ok {
			bad("server.start_dir", "config.err.abspath")
		} else if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			bad("server.start_dir", "config.err.notdir", dir)
		} else {
			s.StartDir = dir
		}
	}
	return probs
}

// integer is v as an integer: TOML decodes one as int64, Nix (through JSON)
// as a float64 with nothing after the point.
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

// nixEvalTimeout bounds `nix eval` of a config.nix.
const nixEvalTimeout = 20 * time.Second

// readNix evaluates a Nix file with `nix eval --json --file`, the way shj
// does. found is false when the file does not exist or does not evaluate.
func readNix(path string) (raw map[string]any, probs []Problem, found bool) {
	if _, err := os.Stat(path); err != nil {
		return nil, nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), nixEvalTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nix", "--extra-experimental-features", "nix-command",
		"eval", "--json", "--file", path).Output()
	if err != nil {
		reason := err.Error()
		if ee, ok := errors.AsType[*exec.ExitError](err); ok {
			reason = lastLines(string(ee.Stderr))
		} else if ctx.Err() != nil {
			reason = fmt.Sprintf("nix eval did not finish in %s", nixEvalTimeout)
		}
		return nil, []Problem{{File: path, Code: "config.err.nix", Args: []any{reason}}}, false
	}
	if err := json.Unmarshal(out, &raw); err != nil || raw == nil {
		return nil, []Problem{{File: path, Code: "config.err.nixtop"}}, false
	}
	return raw, nil, true
}

// lastLines is the end of a nix error message, where the reason is.
func lastLines(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}
