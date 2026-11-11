package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// skillMD is the skill that tells a coding agent how to use the commands of
// kisui in a pane. The test of this package checks that it covers every command
// of commands, so it stays in step when a command is added.
//
//go:embed skill/SKILL.md
var skillMD []byte

// runSkillInstall is "kisui skill install [dir]": it writes SKILL.md to dir
// (~/.claude/skills/kisui-terminal by default). It returns the process exit
// code.
func runSkillInstall(args []string) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Println(i18n.T("skill.install.usage"))
		return 0
	}
	if len(args) > 1 {
		fmt.Fprintln(os.Stderr, i18n.T("skill.install.usage"))
		return 2
	}
	var dir string
	if len(args) == 1 {
		dir = args[0]
	} else {
		var err error
		if dir, err = defaultSkillDir(); err != nil {
			fmt.Fprintf(os.Stderr, i18n.T("skill.install.failed")+"\n", err)
			return 1
		}
	}
	path, err := writeSkill(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, i18n.T("skill.install.failed")+"\n", err)
		return 1
	}
	fmt.Printf(i18n.T("skill.install.written")+"\n", path)
	return 0
}

// defaultSkillDir is where Claude Code looks for the skills of the user.
func defaultSkillDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "skills", "kisui-terminal"), nil
}

// writeSkill writes SKILL.md in dir (made when it is missing) and returns its path.
func writeSkill(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "SKILL.md")
	return path, os.WriteFile(path, skillMD, 0o644)
}
