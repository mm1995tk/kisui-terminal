package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// writeShj は、dir に実行できる shj を置く。
func writeShj(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "shj"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// runBundledShell は、bundledShell が作る引数と環境変数でシェル sh を対話シェルとして起動し、
// コマンド script の出力を返す。ユーザーの起動ファイルは home の下にある。
func runBundledShell(t *testing.T, sh, home, script string, extraEnv ...string) string {
	t.Helper()
	path, err := exec.LookPath(sh)
	if err != nil {
		t.Skipf("%s is not installed", sh)
	}
	args, env := bundledShell(path, extraEnv)
	args = append(args, "-i", "-c", script)
	cmd := exec.Command(path, args...)
	cmd.Dir = home
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s: %v\n%s", sh, err, out)
	}
	return strings.TrimSpace(string(out))
}

func setupShellTest(t *testing.T) (home, bundled, other string) {
	t.Helper()
	home = t.TempDir()
	bundled = t.TempDir()
	other = filepath.Join(t.TempDir(), "old")
	writeShj(t, bundled)
	writeShj(t, other)
	t.Setenv(EnvShjDir, bundled)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("ZDOTDIR", "")
	t.Setenv("ENV", "")
	t.Setenv("BASH_ENV", "")
	return home, bundled, other
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestShellIntegrationZsh(t *testing.T) {
	home, bundled, other := setupShellTest(t)
	// ユーザーの .zshrc が PATH の先頭に別の shj を入れ、別名も定義する
	writeFile(t, filepath.Join(home, ".zshrc"), "export PATH="+other+":$PATH\nalias hello='echo hi'\n")
	got := runBundledShell(t, "zsh", home, "whence -p shj; alias hello; echo ZD=${ZDOTDIR-unset}")
	want := filepath.Join(bundled, "shj") + "\nhello='echo hi'\nZD=unset"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestShellIntegrationZshZDOTDIR(t *testing.T) {
	home, bundled, other := setupShellTest(t)
	zd := filepath.Join(home, "zd")
	writeFile(t, filepath.Join(zd, ".zshenv"), "export FROM_ENV=1\n")
	writeFile(t, filepath.Join(zd, ".zshrc"), "export PATH="+other+":$PATH\n")
	got := runBundledShell(t, "zsh", home, "whence -p shj; echo $FROM_ENV $ZDOTDIR", "ZDOTDIR="+zd)
	want := filepath.Join(bundled, "shj") + "\n1 " + zd
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestShellIntegrationBash(t *testing.T) {
	home, bundled, other := setupShellTest(t)
	writeFile(t, filepath.Join(home, ".bashrc"), "export PATH="+other+":$PATH\nhello() { echo hi; }\n")
	got := runBundledShell(t, "bash", home, "type -P shj; hello")
	want := filepath.Join(bundled, "shj") + "\nhi"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestShellIntegrationFish(t *testing.T) {
	home, bundled, other := setupShellTest(t)
	writeFile(t, filepath.Join(home, ".config", "fish", "config.fish"), "set -gx PATH "+other+" $PATH\nfunction hello; echo hi; end\n")
	got := runBundledShell(t, "fish", home, "command -s shj; hello")
	want := filepath.Join(bundled, "shj") + "\nhi"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestShellIntegrationNoBundledShj(t *testing.T) {
	setupShellTest(t)
	t.Setenv(EnvShjDir, t.TempDir()) // shj の無いフォルダ
	for _, sh := range []string{"zsh", "bash", "fish"} {
		args, env := bundledShell("/bin/"+sh, []string{"A=1"})
		if args != nil || len(env) != 1 {
			t.Errorf("%s: changed args=%v env=%v", sh, args, env)
		}
	}
}

func TestShellIntegrationUnsupportedShell(t *testing.T) {
	_, bundled, _ := setupShellTest(t)
	args, env := bundledShell("/bin/sh", nil)
	if args != nil || pathOf(env) == "" || !strings.HasPrefix(pathOf(env), bundled) {
		t.Fatalf("args=%v env=%v", args, env)
	}
}

// ユーザーの .zshenv が ZDOTDIR を設定する（XDG 配置）ときも、その ZDOTDIR の .zshrc が読まれる。
func TestShellIntegrationZshZDOTDIRFromZshenv(t *testing.T) {
	home, bundled, other := setupShellTest(t)
	zd := filepath.Join(home, ".config", "zsh")
	writeFile(t, filepath.Join(home, ".zshenv"), "export ZDOTDIR="+zd+"\n")
	writeFile(t, filepath.Join(home, ".zshrc"), "echo WRONG_HOME_ZSHRC\n")
	writeFile(t, filepath.Join(zd, ".zshrc"), "export PATH="+other+":$PATH\nalias hello='echo hi'\n")
	got := runBundledShell(t, "zsh", home, "whence -p shj; alias hello; echo ZD=$ZDOTDIR")
	want := filepath.Join(bundled, "shj") + "\nhello='echo hi'\nZD=" + zd
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
