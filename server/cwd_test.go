package server

import (
	"os"
	"path/filepath"
	"testing"
)

func mkdir(t *testing.T, p ...string) string {
	t.Helper()
	d := filepath.Join(p...)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestFindRoot(t *testing.T) {
	base := normalizePath(t.TempDir())
	home := mkdir(t, base, "home")

	gitRepo := mkdir(t, home, "repo")
	mkdir(t, gitRepo, ".git")
	gitSub := mkdir(t, gitRepo, "a", "b")

	wt := mkdir(t, home, "wt") // git worktree: .git はファイル
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: /x/y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	wtSub := mkdir(t, wt, "src")

	shj := mkdir(t, home, "proj")
	mkdir(t, shj, ".shijimi-editor")
	shjSub := mkdir(t, shj, "d")

	plain := mkdir(t, home, "plain", "deep")

	// ~ の下に .git があっても（dotfiles を git で管理している人）、~ はルートにならない。
	mkdir(t, home, ".git")
	dotfilesSub := mkdir(t, home, "notes")

	cases := []struct {
		name, cwd, root, kind string
		ok                    bool
	}{
		{"git root", gitRepo, gitRepo, "git", true},
		{"git subdir", gitSub, gitRepo, "git", true},
		{"worktree .git file", wtSub, wt, "git", true},
		{"worktree root", wt, wt, "git", true},
		{"shijimi-editor dir", shjSub, shj, "shijimi", true},
		{"no marker uses cwd", plain, plain, "cwd", true},
		{"home itself", home, "", "", false},
		{"slash itself", "/", "", "", false},
		{"home with .git is not a root", dotfilesSub, dotfilesSub, "cwd", true},
		{"relative path", "rel", "", "", false},
	}
	for _, c := range cases {
		root, kind, ok := findRoot(c.cwd, home)
		if root != c.root || kind != c.kind || ok != c.ok {
			t.Errorf("%s: findRoot(%q) = %q, %q, %v; want %q, %q, %v", c.name, c.cwd, root, kind, ok, c.root, c.kind, c.ok)
		}
	}
}

func TestWorkspaceIDAndBranch(t *testing.T) {
	if workspaceID("/a/b") != workspaceID("/a/b") || workspaceID("/a/b") == workspaceID("/a/c") {
		t.Error("workspaceID is not stable or not distinct")
	}
	d := t.TempDir()
	mkdir(t, d, ".git")
	os.WriteFile(filepath.Join(d, ".git", "HEAD"), []byte("ref: refs/heads/feat/x\n"), 0o644)
	if b := gitBranch(d); b != "feat/x" {
		t.Errorf("branch %q", b)
	}
	os.WriteFile(filepath.Join(d, ".git", "HEAD"), []byte("0123456789abcdef\n"), 0o644)
	if b := gitBranch(d); b != "0123456" {
		t.Errorf("detached %q", b)
	}
	// worktree: .git ファイルが gitdir を指す
	wt := t.TempDir()
	gd := mkdir(t, d, "wtgit")
	os.WriteFile(filepath.Join(gd, "HEAD"), []byte("ref: refs/heads/wt\n"), 0o644)
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+gd+"\n"), 0o644)
	if b := gitBranch(wt); b != "wt" {
		t.Errorf("worktree branch %q", b)
	}
	if b := gitBranch(t.TempDir()); b != "" {
		t.Errorf("no git: %q", b)
	}
}
