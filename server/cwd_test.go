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
		{"home itself (even with .git)", home, home, "cwd", true},
		{"slash itself", "/", "/", "cwd", true},
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

func TestGitHead(t *testing.T) {
	const full = "9e11274aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const other = "bbbbbbbcccccccccccccccccccccccccccccccc"
	d := t.TempDir()
	gd := mkdir(t, d, ".git")
	head := func(dir, s string) { os.WriteFile(filepath.Join(dir, "HEAD"), []byte(s+"\n"), 0o644) }
	want := func(root, branch, sha string) {
		t.Helper()
		b, s, ok := gitHead(root)
		if !ok || b != branch || s != sha {
			t.Errorf("gitHead = %q, %q, %v; want %q, %q", b, s, ok, branch, sha)
		}
	}
	// ブランチは ref のファイルから
	head(gd, "ref: refs/heads/feat/x")
	os.MkdirAll(filepath.Join(gd, "refs", "heads", "feat"), 0o755)
	os.WriteFile(filepath.Join(gd, "refs", "heads", "feat", "x"), []byte(full+"\n"), 0o644)
	want(d, "feat/x", "9e11274")
	// コミットで ref が動いたら sha も変わる
	os.WriteFile(filepath.Join(gd, "refs", "heads", "feat", "x"), []byte(other+"\n"), 0o644)
	want(d, "feat/x", "bbbbbbb")
	// ref のファイルが無ければ packed-refs（ヘッダとタグの指す先の行は読まない）
	os.Remove(filepath.Join(gd, "refs", "heads", "feat", "x"))
	os.WriteFile(filepath.Join(gd, "packed-refs"), []byte("# pack-refs with: peeled fully-peeled sorted\n"+full+" refs/heads/feat/xy\n"+other+" refs/heads/feat/x\n^"+full+"\n"), 0o644)
	want(d, "feat/x", "bbbbbbb")
	// コミットがまだ無いブランチは sha なし
	head(gd, "ref: refs/heads/unborn")
	want(d, "unborn", "")
	// detached HEAD はブランチなしで sha だけ（gitBranch は今までどおり sha を返す）
	head(gd, full)
	want(d, "", "9e11274")
	if b := gitBranch(d); b != "9e11274" {
		t.Errorf("gitBranch detached %q", b)
	}
	// worktree: HEAD は gitdir、ref は commondir（共通の .git）にある
	wt := t.TempDir()
	wgd := mkdir(t, gd, "worktrees/wt")
	head(wgd, "ref: refs/heads/wt")
	os.WriteFile(filepath.Join(wgd, "commondir"), []byte("../..\n"), 0o644)
	os.MkdirAll(filepath.Join(gd, "refs", "heads"), 0o755)
	os.WriteFile(filepath.Join(gd, "refs", "heads", "wt"), []byte(other+"\n"), 0o644)
	os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+wgd+"\n"), 0o644)
	want(wt, "wt", "bbbbbbb")
	// git が無い
	if _, _, ok := gitHead(t.TempDir()); ok {
		t.Error("no git: ok")
	}
}
