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

// The other keys of the file are shj's: kisui does not check them.
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

// A nightly kisui reads shijimi-editor-nightly/ when it exists, and
// shijimi-editor/ otherwise.
func TestNightlyDir(t *testing.T) {
	cfg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HOME", t.TempDir())
	if d, _ := UserDir("-nightly"); d != filepath.Join(cfg, "shijimi-editor") {
		t.Fatalf("without the directory: %q", d)
	}
	os.MkdirAll(filepath.Join(cfg, "shijimi-editor-nightly"), 0o755)
	if d, _ := UserDir("-nightly"); d != filepath.Join(cfg, "shijimi-editor-nightly") {
		t.Fatalf("with the directory: %q", d)
	}
}
