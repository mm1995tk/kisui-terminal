package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeVersion は、版ごとのフォルダ（~/.cache/kisui-terminal/<版>/ のような）に、名前を出すだけの kisui と shj を作る。
func fakeVersion(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"kisui", "shj"} {
		script := "#!/bin/sh\necho " + name + " " + tool + ` "$@"` + "\n"
		if err := os.WriteFile(filepath.Join(dir, tool), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// useExecutable は、この kisui の実行ファイルを path に見せる。
func useExecutable(t *testing.T, path string) {
	t.Helper()
	old := executable
	executable = func() (string, error) { return path, nil }
	t.Cleanup(func() { executable = old })
}

// isolateCache は、キャッシュのフォルダをテスト用にする（macOS は $HOME/Library/Caches、Linux は XDG_CACHE_HOME）。
func isolateCache(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv(EnvShjDir, "")
	t.Setenv("PATH", "/usr/bin:/bin")
}

func envValue(env []string, key string) string {
	v := ""
	for _, e := range env {
		if x, ok := strings.CutPrefix(e, key+"="); ok {
			v = x
		}
	}
	return v
}

// 版を上げて serve が引き継いだあと、前から開いていたシェルの shj・pbcopy・pbpaste は新しい版を起動する。
// 古い版のフォルダが消されても動く。
func TestCurrentFollowsNewVersion(t *testing.T) {
	isolateCache(t)
	v1, v2 := fakeVersion(t, "v1"), fakeVersion(t, "v2")

	useExecutable(t, filepath.Join(v1, "kisui"))
	_, env := bundledShell("/bin/sh", nil)     // 古い版の serve が始めたシェル
	cur, _, _ := strings.Cut(pathOf(env), ":") // sh は包まないので KISUI_SHJ_PATH_DIR は渡さない。PATH の先頭を見る
	if cur == "" || strings.Contains(cur, v1) {
		t.Fatalf("PATH = %q, want a folder independent of the version first", pathOf(env))
	}
	if got := envValue(env, envKisuiExe); got != filepath.Join(cur, "kisui") {
		t.Fatalf("%s = %q", envKisuiExe, got)
	}
	if p := pathOf(env); strings.Contains(p, v1) || !strings.HasPrefix(p, cur+":") {
		t.Fatalf("PATH = %q", p)
	}
	if fi, err := os.Stat(cur); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("current dir: %v %v", fi, err)
	}

	run := func() string {
		t.Helper()
		cmd := exec.Command("/bin/sh", "-c", "shj; printf x | pbcopy; pbpaste")
		cmd.Env = append(os.Environ(), env...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return string(out)
	}
	if got, want := run(), "v1 shj\nv1 kisui clipboard copy\nv1 kisui clipboard paste\n"; got != want {
		t.Fatalf("before handover: %q, want %q", got, want)
	}

	// 新しい版の serve が引き継いで始まる（Serve が向け直す）。古い版のフォルダは消される
	useExecutable(t, filepath.Join(v2, "kisui"))
	if _, err := pointCurrent(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(v1); err != nil {
		t.Fatal(err)
	}
	if got, want := run(), "v2 shj\nv2 kisui clipboard copy\nv2 kisui clipboard paste\n"; got != want {
		t.Fatalf("after handover: %q, want %q", got, want)
	}
	// 向け直しの一時的な名前は残らない
	ents, err := os.ReadDir(cur)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	if strings.Join(names, " ") != "kisui shj" {
		t.Fatalf("current dir has %v", names)
	}

	// 新しい版に同梱の shj が無ければ、shj のリンクを消す（PATH のほかの shj を使う）
	if err := os.Remove(filepath.Join(v2, "shj")); err != nil {
		t.Fatal(err)
	}
	if _, err := pointCurrent(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(cur, "shj")); !os.IsNotExist(err) {
		t.Fatalf("shj link left: %v", err)
	}
}

// ターミナルの中のコマンド（シェルでないもの）の PATH にも、版によらないフォルダを足す。
func TestWithKisuiPathUsesCurrent(t *testing.T) {
	isolateCache(t)
	v1 := fakeVersion(t, "v1")
	useExecutable(t, filepath.Join(v1, "kisui"))
	cur, err := pointCurrent()
	if err != nil {
		t.Fatal(err)
	}
	if p := pathOf(withKisuiPath(nil)); p != cur+":/usr/bin:/bin" {
		t.Fatalf("PATH = %q", p)
	}
	// bundledShell がもう一度足しても、PATH に 2 回は入らない
	_, env := bundledShell("/bin/sh", withKisuiPath(nil))
	if p := pathOf(env); strings.Count(p, cur) != 1 {
		t.Fatalf("PATH = %q", p)
	}
}

// ほかのユーザーが書き換えられるフォルダなら版によらないフォルダを使わず、今まで通り版ごとのフォルダを渡す。
func TestCurrentRefusesUnsafeDir(t *testing.T) {
	v1 := fakeVersion(t, "v1")
	for _, tc := range []struct {
		name  string
		spoil func(t *testing.T, parent, cur string)
	}{
		{"parent writable by others", func(t *testing.T, parent, cur string) {
			if err := os.Chmod(parent, 0o777); err != nil {
				t.Fatal(err)
			}
		}},
		{"current writable by group", func(t *testing.T, parent, cur string) {
			if err := os.Chmod(cur, 0o770); err != nil {
				t.Fatal(err)
			}
		}},
		{"current is a symlink", func(t *testing.T, parent, cur string) {
			if err := os.RemoveAll(cur); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), cur); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolateCache(t)
			useExecutable(t, filepath.Join(v1, "kisui"))
			cur, err := pointCurrent()
			if err != nil {
				t.Fatal(err)
			}
			tc.spoil(t, filepath.Dir(cur), cur)
			if _, err := pointCurrent(); err == nil {
				t.Fatal("unsafe dir accepted")
			}
			_, env := bundledShell("/bin/sh", nil)
			if got, _, _ := strings.Cut(pathOf(env), ":"); got != v1 {
				t.Fatalf("PATH = %q, want %q first", pathOf(env), v1)
			}
			if got := envValue(env, envKisuiExe); got != filepath.Join(v1, "kisui") {
				t.Fatalf("%s = %q", envKisuiExe, got)
			}
		})
	}
}

// 実行ファイルが kisui でないとき（go test・go run）は、版によらないフォルダに触らない。
func TestCurrentSkippedWhenNotKisui(t *testing.T) {
	isolateCache(t)
	useExecutable(t, filepath.Join(t.TempDir(), "server.test"))
	if cur, err := pointCurrent(); err != nil || cur != "" {
		t.Fatalf("pointCurrent = %q, %v", cur, err)
	}
}
