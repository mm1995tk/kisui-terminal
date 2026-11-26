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

func TestShell(t *testing.T) {
	dir := userDir(t)
	home, _ := os.UserHomeDir()
	sh := filepath.Join(home, "bin", "mysh")
	os.MkdirAll(filepath.Dir(sh), 0o755)
	os.WriteFile(sh, []byte("#!/bin/sh\n"), 0o755)
	write := func(v string) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte("[server]\nshell = "+v+"\n"), 0o644)
	}
	if s, err := Load(""); err != nil || s.Shell != "" {
		t.Fatalf("no shell: %q, %v", s.Shell, err)
	}
	for _, v := range []string{`"~/bin/mysh"`, `"` + sh + `"`} {
		write(v)
		if s, err := Load(""); err != nil || s.Shell != sh {
			t.Errorf("shell = %s: %q, %v", v, s.Shell, err)
		}
	}
	// 無いファイル・実行できないファイルは、設定の間違いにしない（kisui serve は起動し、始めるときに $SHELL に替える）
	os.WriteFile(filepath.Join(home, "bin", "plain"), []byte("x"), 0o644)
	for _, name := range []string{"none", "plain"} {
		write(`"~/bin/` + name + `"`)
		if s, err := Load(""); err != nil || s.Shell != filepath.Join(home, "bin", name) {
			t.Errorf("shell = ~/bin/%s: %q, %v", name, s.Shell, err)
		}
	}
	// 書けない形は、設定の間違い（kisui serve は起動しない）
	for v, want := range map[string]string{
		`"bash"`:  "absolute path",    // PATH からは探さない
		`"sh -l"`: "absolute path",    // 引数は書けない
		`""`:      "absolute path",    // 空
		`1`:       "must be a string", // 型
	} {
		write(v)
		_, err := Load("")
		if err == nil || !strings.Contains(err.Error(), "server.shell") || !strings.Contains(err.Error(), want) {
			t.Errorf("shell = %s: %v", v, err)
		}
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

// [server] pane_reach is "own" (the default) or "all"; anything else is a mistake.
func TestPaneReach(t *testing.T) {
	dir := userDir(t)
	write := func(s string) (*Settings, error) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(s), 0o644)
		return Load("")
	}
	if s, err := write(""); err != nil || s.PaneReach != PaneReachOwn {
		t.Fatalf("default: %q, %v", s.PaneReach, err)
	}
	if s, err := write("[server]\npane_reach = \"all\"\n"); err != nil || s.PaneReach != PaneReachAll {
		t.Fatalf("all: %q, %v", s.PaneReach, err)
	}
	if s, err := write("[server]\npane_reach = \"own\"\n"); err != nil || s.PaneReach != PaneReachOwn {
		t.Fatalf("own: %q, %v", s.PaneReach, err)
	}
	for name, c := range map[string]string{
		"unknown": "[server]\npane_reach = \"everything\"\n",
		"bool":    "[server]\npane_reach = true\n",
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

// config.local.toml is applied on top of config.toml: a key in it wins, and
// the keys of [server] are taken one by one.
func TestLocalWins(t *testing.T) {
	dir := userDir(t)
	work := filepath.Join(os.Getenv("HOME"), "work")
	os.Mkdir(work, 0o755)
	os.WriteFile(filepath.Join(dir, "config.toml"), []byte("ui-language = \"en\"\n[server]\nidle_stop_days = 3\nstart_dir = \"~/work\"\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("ui-language = \"ja\"\n[server]\nidle_stop_days = 0\n"), 0o644)
	s, err := Load("")
	if err != nil || s.UILanguage != "ja" || s.IdleStopDays != 0 || s.StartDir != work {
		t.Fatalf("merged: %+v, %v", s, err)
	}
}

// config.local.toml alone is enough.
func TestLocalOnly(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.local.toml"), []byte("ui-language = \"ja\"\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "ja" {
		t.Fatalf("local only: %+v, %v", s, err)
	}
}

// A mistake in config.local.toml names that file.
func TestLocalError(t *testing.T) {
	dir := userDir(t)
	path := filepath.Join(dir, "config.local.toml")
	os.WriteFile(path, []byte("[server]\nidle_stop_days = -1\n"), 0o644)
	if _, err := Load(""); err == nil || !strings.HasPrefix(err.Error(), path+": server.idle_stop_days: ") {
		t.Fatalf("err = %v", err)
	}
}

// config.nix is not read any more.
func TestNixIsNotRead(t *testing.T) {
	dir := userDir(t)
	os.WriteFile(filepath.Join(dir, "config.nix"), []byte("{ ui-language = \"ja\"; server.idle_stop_days = 1; }\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "en" || s.IdleStopDays != 7 {
		t.Fatalf("config.nix was read: %+v, %v", s, err)
	}
}

// The settings of shj (~/.config/shijimi-editor/) are not read, ui-language
// included.
func TestShjIsNotRead(t *testing.T) {
	userDir(t)
	shj := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "shijimi-editor")
	os.MkdirAll(shj, 0o755)
	os.WriteFile(filepath.Join(shj, "config.toml"), []byte("ui-language = \"ja\"\n[server]\nidle_stop_days = 3\n"), 0o644)
	if s, err := Load(""); err != nil || s.UILanguage != "en" || s.IdleStopDays != 7 {
		t.Fatalf("settings from shj: %+v, %v", s, err)
	}
}
