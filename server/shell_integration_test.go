package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
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

// KISUI_EXE の kisui が無くなっていたら（更新で入れ替わったなど）、PATH の kisui を呼ぶ。
func TestShellIntegrationPbcopyKisuiExeGone(t *testing.T) {
	home, _, other := setupShellTest(t)
	setupClipboardTest(t, other)
	_, env := bundledShell("/bin/sh", nil)
	cmd := exec.Command("/bin/sh", "-c", "echo hi | pbcopy")
	cmd.Dir = home
	cmd.Env = append(os.Environ(), append(env, envKisuiExe+"="+filepath.Join(t.TempDir(), "kisui"))...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "kisui clipboard copy hi" {
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

// runBundledShellPTY は、bundledShell が作る引数と環境変数でシェル sh を、疑似端末の上の対話シェルとして起動し、
// コマンド cmds を 1 行ずつ打って、シェルが終わるまでの出力を返す。
func runBundledShellPTY(t *testing.T, sh, home string, cmds ...string) string {
	t.Helper()
	path, err := exec.LookPath(sh)
	if err != nil {
		t.Skipf("%s is not installed", sh)
	}
	args, env := bundledShell(path, nil)
	args = append(args, "-i")
	cmd := exec.Command(path, args...)
	cmd.Dir = home
	cmd.Env = append(os.Environ(), env...)
	cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatal(err)
	}
	defer ptmx.Close()
	done := make(chan string, 1)
	go func() {
		var out strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			out.Write(buf[:n])
			if err != nil {
				done <- out.String()
				return
			}
		}
	}()
	// 最初のプロンプトが出るのを待ってから打つ
	time.Sleep(500 * time.Millisecond)
	for _, c := range cmds {
		ptmx.WriteString(c + "\n")
		time.Sleep(200 * time.Millisecond)
	}
	ptmx.WriteString("exit\n")
	select {
	case out := <-done:
		return out
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		t.Fatal("the shell did not exit")
		return ""
	}
}

// osc133 は、出力の中の OSC 133 の印（A・B・C・D;n）を出てきた順に返す。
func osc133(out string) []string {
	var marks []string
	for {
		i := strings.Index(out, "\x1b]133;")
		if i < 0 {
			return marks
		}
		out = out[i+len("\x1b]133;"):]
		j := strings.IndexByte(out, '\a')
		if j < 0 {
			return marks
		}
		marks = append(marks, out[:j])
	}
}

func TestShellIntegrationOSC133(t *testing.T) {
	// 1 つ目のコマンドは成功、2 つ目は失敗する。最初のプロンプトの前には D が無い。
	cases := []struct {
		sh   string
		want []string
	}{
		{"zsh", []string{"A", "B", "C", "D;0", "A", "B", "C", "D;3", "A", "B"}},
		{"bash", []string{"A", "B", "C", "D;0", "A", "B", "C", "D;3", "A", "B"}},
	}
	for _, c := range cases {
		t.Run(c.sh, func(t *testing.T) {
			home, _, _ := setupShellTest(t)
			out := runBundledShellPTY(t, c.sh, home, "true", "(exit 3)")
			got := osc133(out)
			// exit を打ったあとの印は見ない
			if len(got) < len(c.want) || strings.Join(got[:len(c.want)], " ") != strings.Join(c.want, " ") {
				t.Fatalf("marks %q, want prefix %q\n%q", got, c.want, out)
			}
		})
	}
}

// ユーザーの設定がすでに OSC 133 を出しているときは、kisui は足さない。
func TestShellIntegrationOSC133NotDoubled(t *testing.T) {
	cases := []struct {
		sh, rc, file string
	}{
		{"zsh", "_user_precmd() { printf '\\e]133;A\\a' }\nprecmd_functions+=(_user_precmd)\n", ".zshrc"},
		{"zsh", "PS1=$'%{\\e]133;A\\a%}% '\n", ".zshrc"},
		{"bash", "_user_pc() { printf '\\e]133;A\\a'; }\nPROMPT_COMMAND=_user_pc\n", ".bashrc"},
		{"bash", "PS1='\\[\\e]133;A\\a\\]$ '\n", ".bashrc"},
	}
	for i, c := range cases {
		t.Run(fmt.Sprintf("%s-%d", c.sh, i), func(t *testing.T) {
			home, _, _ := setupShellTest(t)
			writeFile(t, filepath.Join(home, c.file), c.rc)
			out := runBundledShellPTY(t, c.sh, home, "true", "true")
			if strings.Contains(out, "133;B") || strings.Contains(out, "133;C") || strings.Contains(out, "133;D") {
				t.Fatalf("kisui added marks on top of the user's: %q", out)
			}
			if !strings.Contains(out, "\x1b]133;A\a") {
				t.Fatalf("the user's own mark is missing: %q", out)
			}
		})
	}
}
