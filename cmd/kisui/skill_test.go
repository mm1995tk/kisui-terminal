package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// walkCommands calls f with the words of each command that runs ("pane split").
func walkCommands(cmds []command, prefix string, f func(path string, c command)) {
	for _, c := range cmds {
		path := strings.TrimSpace(prefix + " " + c.name)
		if c.run == nil {
			walkCommands(c.sub, path, f)
			continue
		}
		f(path, c)
	}
}

// SKILL.md has a heading for every command that runs in a pane. The commands
// that do not ("serve", "attach", "skill install") are not for the agent.
func TestSkillCoversCommands(t *testing.T) {
	notForAgent := map[string]bool{"serve": true, "attach": true, "relay": true, "skill install": true}
	text := string(skillMD)
	walkCommands(commands, "", func(path string, c command) {
		if notForAgent[path] {
			return
		}
		synopsis := "kisui " + path
		if c.args != "" {
			synopsis += " " + c.args
		}
		if !strings.Contains(text, "### "+synopsis+"\n") {
			t.Errorf("SKILL.md has no heading %q: add the usage of the new command (or list it in notForAgent)", "### "+synopsis)
		}
	})
}

func TestSkillInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if code := runSkillInstall(nil); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	got, err := os.ReadFile(filepath.Join(home, ".claude", "skills", "kisui-terminal", "SKILL.md"))
	if err != nil || string(got) != string(skillMD) {
		t.Fatalf("default dir: %v", err)
	}
	dir := filepath.Join(t.TempDir(), "a", "b")
	if code := runSkillInstall([]string{dir}); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "SKILL.md")); err != nil || string(got) != string(skillMD) {
		t.Fatalf("given dir: %v", err)
	}
	if code := runSkillInstall([]string{"a", "b"}); code != 2 {
		t.Fatalf("two arguments: %d", code)
	}
}
