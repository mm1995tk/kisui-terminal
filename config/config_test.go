package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mm1995tk/shijimi-editor/core/config"
)

func opts() config.Options { return config.Options{Sections: []config.Section{Section}} }

func TestServeStartDir(t *testing.T) {
	home := t.TempDir()
	cfgHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfgHome)
	t.Setenv("HOME", home)
	dir := filepath.Join(home, "work")
	os.Mkdir(dir, 0o755)
	userDir, _ := config.UserDir(opts())
	os.MkdirAll(userDir, 0o755)
	write := func(v string) {
		os.WriteFile(filepath.Join(userDir, "config.toml"), []byte("[server]\nstart_dir = "+v+"\n"), 0o644)
	}
	write(`"~/work"`)
	c, err := config.Load(t.TempDir(), opts())
	if err != nil || Of(c).StartDir != dir {
		t.Fatalf("start_dir = %q, %v", Of(c).StartDir, err)
	}
	if c, err := config.Load(t.TempDir(), opts()); err != nil || Of(c).StartDir == "" {
		t.Fatal(err)
	}
	// A folder that is not there is a mistake in the file.
	write(`"~/missing"`)
	if _, err := config.Load(t.TempDir(), opts()); err == nil {
		t.Error("a start_dir that does not exist was accepted")
	}
	write(`"relative/dir"`)
	if _, err := config.Load(t.TempDir(), opts()); err == nil {
		t.Error("a relative start_dir was accepted")
	}
	os.Remove(filepath.Join(userDir, "config.toml"))
	if c, err := config.Load(t.TempDir(), opts()); err != nil || Of(c).StartDir != "" {
		t.Errorf("default start_dir = %q, %v", Of(c).StartDir, err)
	}
}

func TestServeIdleStopDays(t *testing.T) {
	root := t.TempDir()
	cfg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HOME", t.TempDir())
	dir := filepath.Join(cfg, "shijimi-editor")
	os.MkdirAll(dir, 0o755)
	write := func(s string) (*config.Config, error) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(s), 0o644)
		return config.Load(root, opts())
	}
	if c, err := write(""); err != nil || Of(c).IdleStopDays != 7 {
		t.Fatalf("default: %d, %v", Of(c).IdleStopDays, err)
	}
	if c, err := write("[server]\nidle_stop_days = 0\n"); err != nil || Of(c).IdleStopDays != 0 {
		t.Fatalf("0: %d, %v", Of(c).IdleStopDays, err)
	}
	if c, err := write("[server]\nidle_stop_days = 3\n"); err != nil || Of(c).IdleStopDays != 3 {
		t.Fatalf("3: %d, %v", Of(c).IdleStopDays, err)
	}
	if _, err := write("[server]\nidle_stop_days = -1\n"); err == nil {
		t.Fatal("negative must be an error")
	}
	if _, err := write("[server]\nidle_stop_days = \"x\"\n"); err == nil {
		t.Fatal("string must be an error")
	}
}

// The GUI reads [[gui.machines]]; shj must start with a file that has it, and
// still reports a mistake in it.
func TestGUIMachines(t *testing.T) {
	root := t.TempDir()
	cfg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("HOME", t.TempDir())
	dir := filepath.Join(cfg, "shijimi-editor")
	os.MkdirAll(dir, 0o755)
	write := func(s string) {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(s), 0o644)
	}
	write("[[gui.machines]]\nssh = \"dev-vm\"\nname = \"dev\"\n\n[[gui.machines]]\nssh = \"build\"\n")
	if _, err := config.Load(root, opts()); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]string{
		"missing ssh":   "[[gui.machines]]\nname = \"dev\"\n",
		"wrong type":    "[[gui.machines]]\nssh = 1\n",
		"negative days": "[server]\nidle_stop_days = -1\n",
		"float days":    "[server]\nidle_stop_days = 1.5\n",
	} {
		write(c)
		if _, err := config.Load(root, opts()); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// A key of [gui] this version does not read is a warning, not a stop.
func TestGUIUnknownKeyIsWarning(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	dir, _ := config.UserDir(opts())
	os.MkdirAll(dir, 0o755)
	for _, c := range []string{"[[gui.machines]]\nssh = \"a\"\nhost = \"b\"\n", "[gui]\ncolor = 1\n"} {
		os.WriteFile(filepath.Join(dir, "config.toml"), []byte(c), 0o644)
		cfg, err := config.Load(root, opts())
		if err != nil || len(cfg.Warnings) != 1 {
			t.Errorf("%q: err = %v, warnings = %v", c, err, cfg.Warnings)
		}
	}
}
