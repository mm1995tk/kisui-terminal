package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// userDir makes a fresh configuration directory and returns it.
func userDir(t *testing.T) string {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	dir, _ := UserDir("")
	os.MkdirAll(dir, 0o755)
	return dir
}

func TestDefaults(t *testing.T) {
	userDir(t)
	s, err := Load("")
	if err != nil || s.IdleStopDays != 7 || s.StartDir != "" || s.UILanguage != "en" {
		t.Fatalf("defaults: %+v, %v", s, err)
	}
}

func TestStartDir(t *testing.T) {
	dir := userDir(t)
	work := filepath.Join(os.Getenv("HOME"), "work")
	os.Mkdir(work, 0o755)
	write := func(v string) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[server]\nstart_dir = "+v+"\n"), 0o644)
	}
	write(`"~/work"`)
	if s, err := Load(""); err != nil || s.StartDir != work {
		t.Fatalf("start_dir = %q, %v", s.StartDir, err)
	}
	// A folder that is not there is a mistake in the file.
	write(`"~/missing"`)
	if _, err := Load(""); err == nil || !strings.Contains(err.Error(), "server.start_dir") {
		t.Errorf("a start_dir that does not exist was accepted: %v", err)
	}
	write(`"relative/dir"`)
	if _, err := Load(""); err == nil {
		t.Error("a relative start_dir was accepted")
	}
	write(`1`)
	if _, err := Load(""); err == nil {
		t.Error("a number was accepted")
	}
}

func TestIdleStopDays(t *testing.T) {
	dir := userDir(t)
	write := func(s string) (*Settings, error) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(s), 0o644)
		return Load("")
	}
	if s, err := write("[server]\nidle_stop_days = 0\n"); err != nil || s.IdleStopDays != 0 {
		t.Fatalf("0: %d, %v", s.IdleStopDays, err)
	}
	if s, err := write("[server]\nidle_stop_days = 3\n"); err != nil || s.IdleStopDays != 3 {
		t.Fatalf("3: %d, %v", s.IdleStopDays, err)
	}
	for name, c := range map[string]string{
		"negative":    "[server]\nidle_stop_days = -1\n",
		"string":      "[server]\nidle_stop_days = \"x\"\n",
		"float":       "[server]\nidle_stop_days = 1.5\n",
		"not a table": "server = 1\n",
	} {
		if _, err := write(c); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// Keys that are not kisui's are left alone: kisui does not check them.
func TestOtherKeysAreIgnored(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("theme = 1\n[editor]\nx = \"y\"\n[[gui.machines]]\nssh = \"a\"\n[server]\nunknown = true\n"), 0o644)
	if _, err := Load(""); err != nil {
		t.Fatal(err)
	}
}

func TestUILanguage(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("ui-language = \"ja\"\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "ja" {
		t.Fatalf("ui-language = %q, %v", s.UILanguage, err)
	}
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("ui-language = \"fr\"\n"), 0o644)
	if s, err := Load(""); err == nil || s.UILanguage != "en" {
		t.Fatalf("an unsupported language is an error: %q, %v", s.UILanguage, err)
	}
}

// A TOML mistake names the file and the line.
func TestSyntaxError(t *testing.T) {
	dir := userDir(t)
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, []byte("[server]\nidle_stop_days = \n"), 0o644)
	_, err := Load("")
	if err == nil || !strings.HasPrefix(err.Error(), path+":2: ") {
		t.Fatalf("err = %v", err)
	}
}

// A nightly kisui reads kisui-terminal-nightly/ when it exists, and
// kisui-terminal/ otherwise.
func TestNightlyDir(t *testing.T) {
	cfg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HOME", t.TempDir())
	if d, _ := UserDir("-nightly"); d != filepath.Join(cfg, "kisui-terminal") {
		t.Fatalf("without the directory: %q", d)
	}
	os.MkdirAll(filepath.Join(cfg, "kisui-terminal-nightly"), 0o755)
	if d, _ := UserDir("-nightly"); d != filepath.Join(cfg, "kisui-terminal-nightly") {
		t.Fatalf("with the directory: %q", d)
	}
	if d, _ := UserDir(""); d != filepath.Join(cfg, "kisui-terminal") {
		t.Fatalf("stable: %q", d)
	}
}

// A relative $XDG_CONFIG_HOME is not used.
func TestRelativeXDG(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "rel")
	t.Setenv("HOME", home)
	if d, _ := UserDir(""); d != filepath.Join(home, ".config", "kisui-terminal") {
		t.Fatalf("dir = %q", d)
	}
}

// shjConfig writes shj's config.toml, which is next to kisui-terminal's directory.
func shjConfig(t *testing.T, text string) {
	t.Helper()
	dir, _ := shjDir("")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte(text), 0o644)
}

// [server] and [[gui.machines]] in shj's config.toml are not read any more.
func TestOldLocationIsNotRead(t *testing.T) {
	userDir(t)
	shjConfig(t, "[server]\nidle_stop_days = 3\nstart_dir = \"/nonexistent-dir\"\n[[gui.machines]]\nssh = \"a\"\n")
	s, err := Load("")
	if err != nil || s.IdleStopDays != 7 || s.StartDir != "" {
		t.Fatalf("settings from the old place: %+v, %v", s, err)
	}
}

// ui-language is the one key read from shj's config.toml, when kisui-terminal's
// settings do not have it.
func TestUILanguageFallsBackToShj(t *testing.T) {
	dir := userDir(t)
	shjConfig(t, "ui-language = \"ja\"\n")
	if s, err := Load(""); err != nil || s.UILanguage != "ja" {
		t.Fatalf("fallback: %q, %v", s.UILanguage, err)
	}
	// Its own setting wins, even when it is the default.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("ui-language = \"en\"\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "en" {
		t.Fatalf("own setting: %q, %v", s.UILanguage, err)
	}
	// A file of kisui-terminal that has no ui-language still falls back.
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[server]\nidle_stop_days = 1\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "ja" || s.IdleStopDays != 1 {
		t.Fatalf("no ui-language of its own: %+v, %v", s, err)
	}
	// A value kisui does not have, or a broken file, is shj's to report.
	shjConfig(t, "ui-language = \"fr\"\n")
	if s, err := Load(""); err != nil || s.UILanguage != "en" {
		t.Fatalf("unsupported language in shj's file: %q, %v", s.UILanguage, err)
	}
	shjConfig(t, "ui-language = \n")
	if s, err := Load(""); err != nil || s.UILanguage != "en" {
		t.Fatalf("broken shj file: %q, %v", s.UILanguage, err)
	}
}

func TestMoved(t *testing.T) {
	userDir(t)
	if _, keys := Moved(""); len(keys) != 0 {
		t.Fatalf("no file: %v", keys)
	}
	shjConfig(t, "theme = \"x\"\nui-language = \"ja\"\n[gui]\ncolor = 1\n")
	if _, keys := Moved(""); len(keys) != 0 {
		t.Fatalf("shj's own keys: %v", keys)
	}
	shjConfig(t, "[[gui.machines]]\nssh = \"a\"\n")
	if p, keys := Moved(""); strings.Join(keys, ",") != "gui.machines" || !strings.HasSuffix(p, "shijimi-editor/config.toml") {
		t.Fatalf("machines: %s %v", p, keys)
	}
	shjConfig(t, "[server]\nidle_stop_days = 1\n[[gui.machines]]\nssh = \"a\"\n")
	if _, keys := Moved(""); strings.Join(keys, ",") != "server,gui.machines" {
		t.Fatalf("both: %v", keys)
	}
}
