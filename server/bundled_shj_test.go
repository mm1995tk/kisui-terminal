package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pathOf(env []string) string {
	p := ""
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "PATH="); ok {
			p = v
		}
	}
	return p
}

func TestWithBundledShj(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("HOME", t.TempDir())
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	root, err := writeShellInit()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin") // pbcopy・pbpaste のフォルダ。shj の有無に関係なく足す
	dir := t.TempDir()

	// 同梱が無ければ、pbcopy・pbpaste のフォルダだけを足す
	t.Setenv(EnvShjDir, dir)
	if _, got := bundledShell("/bin/sh", []string{"A=1"}); pathOf(got) != bin+":/usr/bin:/bin" {
		t.Fatalf("no shj: PATH = %q", pathOf(got))
	}
	// 実行できない shj は使わない
	if err := os.WriteFile(filepath.Join(dir, "shj"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, got := bundledShell("/bin/sh", nil); pathOf(got) != bin+":/usr/bin:/bin" {
		t.Fatalf("non-executable shj used: PATH = %q", pathOf(got))
	}
	if err := os.Chmod(filepath.Join(dir, "shj"), 0o755); err != nil {
		t.Fatal(err)
	}

	// kisui の PATH の先頭に足す
	env := []string{"A=1"}
	_, got := bundledShell("/bin/sh", env)
	if p := pathOf(got); p != dir+":"+bin+":/usr/bin:/bin" {
		t.Fatalf("PATH = %q", p)
	}
	if len(env) != 1 {
		t.Fatal("input env was modified")
	}
	// 呼ぶ側が PATH を指していれば、それの先頭に足す
	_, e2 := bundledShell("/bin/sh", []string{"PATH=/x"})
	if p := pathOf(e2); p != dir+":"+bin+":/x" {
		t.Fatalf("PATH = %q", p)
	}
}

func TestBundledShjDirNextToKisui(t *testing.T) {
	t.Setenv(EnvShjDir, "")
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	// テストの実行ファイルの隣に shj は無い
	if d := bundledShjDir(); d != "" {
		t.Fatalf("unexpected dir %q next to %s", d, exe)
	}
}
