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
	dir := t.TempDir()

	// 同梱が無ければ変えない
	t.Setenv(EnvShjDir, dir)
	if got := withBundledShj([]string{"A=1"}); len(got) != 1 {
		t.Fatalf("no shj: env changed: %v", got)
	}
	// 実行できない shj は使わない
	if err := os.WriteFile(filepath.Join(dir, "shj"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := withBundledShj(nil); got != nil {
		t.Fatalf("non-executable shj used: %v", got)
	}
	if err := os.Chmod(filepath.Join(dir, "shj"), 0o755); err != nil {
		t.Fatal(err)
	}

	// kisui の PATH の先頭に足す
	env := []string{"A=1"}
	got := withBundledShj(env)
	if p := pathOf(got); p != dir+":/usr/bin:/bin" {
		t.Fatalf("PATH = %q", p)
	}
	if len(env) != 1 {
		t.Fatal("input env was modified")
	}
	// 呼ぶ側が PATH を指していれば、それの先頭に足す
	if p := pathOf(withBundledShj([]string{"PATH=/x"})); p != dir+":/x" {
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
