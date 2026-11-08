package server

import (
	"fmt"
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

// setupClipboardTest は、引数と標準入力を出すだけの偽の kisui を PATH に置き、
// ユーザーの起動ファイルが PATH の先頭に入れる別の pbcopy・pbpaste（macOS の /usr/bin のもの）を other に置く。
func setupClipboardTest(t *testing.T, other string) {
	t.Helper()
	fake := t.TempDir()
	if err := os.WriteFile(filepath.Join(fake, "kisui"), []byte("#!/bin/sh\necho \"kisui $*\" \"$(cat)\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pbcopy", "pbpaste"} {
		if err := os.WriteFile(filepath.Join(other, name), []byte("#!/bin/sh\necho WRONG_"+name+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", fake+":"+os.Getenv("PATH"))
	t.Setenv(envKisuiExe, "")
}

// 欄のシェルでは pbcopy・pbpaste が kisui clipboard copy / paste を呼ぶ。ユーザーの起動ファイルが別の pbcopy を
// 前に出しても、スクリプトの中から呼んでも、同梱の shj が無くても同じ。
func TestShellIntegrationPbcopy(t *testing.T) {
	const script = "echo hi | pbcopy; pbpaste </dev/null; sh -c 'echo yo | pbcopy'"
	const want = "kisui clipboard copy hi\nkisui clipboard paste \nkisui clipboard copy yo"
	rc := map[string]string{
		"zsh":  ".zshrc",
		"bash": ".bashrc",
		"fish": filepath.Join(".config", "fish", "config.fish"),
	}
	for sh, file := range rc {
		for _, noShj := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/noShj=%v", sh, noShj), func(t *testing.T) {
				home, _, other := setupShellTest(t)
				if noShj {
					t.Setenv(EnvShjDir, t.TempDir()) // shj の無いフォルダ
				}
				setupClipboardTest(t, other)
				line := "export PATH=" + other + ":$PATH\n"
				if sh == "fish" {
					line = "set -gx PATH " + other + " $PATH\n"
				}
				writeFile(t, filepath.Join(home, file), line)
				if got := runBundledShell(t, sh, home, script); got != want {
					t.Errorf("got %q, want %q", got, want)
				}
			})
		}
	}
}

func TestShellIntegrationPbcopyUnsupportedShell(t *testing.T) {
	home, _, other := setupShellTest(t)
	t.Setenv(EnvShjDir, t.TempDir())
	setupClipboardTest(t, other)
	args, env := bundledShell("/bin/sh", nil)
	if args != nil {
		t.Fatalf("args=%v", args)
	}
	cmd := exec.Command("/bin/sh", "-c", "echo hi | pbcopy")
	cmd.Dir = home
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "kisui clipboard copy hi" {
		t.Fatalf("got %q", got)
	}
}

// pbcopy・pbpaste は、kisui serve が渡す KISUI_EXE の kisui を呼ぶ（PATH に kisui が無くても動く）。
func TestShellIntegrationPbcopyKisuiExe(t *testing.T) {
	home, _, _ := setupShellTest(t)
	exe := filepath.Join(t.TempDir(), "kisui")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho \"exe $*\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, env := bundledShell("/bin/sh", nil)
	cmd := exec.Command("/bin/sh", "-c", "pbpaste")
	cmd.Dir = home
	cmd.Env = append(os.Environ(), append(env, envKisuiExe+"="+exe)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "exe clipboard paste" {
		t.Fatalf("got %q", got)
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
