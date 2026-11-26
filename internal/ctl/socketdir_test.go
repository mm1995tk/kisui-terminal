package ctl

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/i18n"
)

// socketDirIn makes base the directory the socket directory goes under, by
// XDG_RUNTIME_DIR or (xdg false) by TMPDIR, and returns the path SocketDir
// uses there.
func socketDirIn(t *testing.T, base string, xdg bool) string {
	t.Helper()
	if xdg {
		t.Setenv("XDG_RUNTIME_DIR", base)
	} else {
		t.Setenv("XDG_RUNTIME_DIR", "")
		t.Setenv("TMPDIR", base)
	}
	return filepath.Join(base, fmt.Sprintf("shijimi-%d", os.Getuid()))
}

// wantProblem fails unless err is a *SocketDirError of dir with that problem.
func wantProblem(t *testing.T, err error, dir, problem string) {
	t.Helper()
	var de *SocketDirError
	if !errors.As(err, &de) {
		t.Fatalf("err = %v, want a *SocketDirError (%s)", err, problem)
	}
	if de.Problem != problem || de.Dir != dir {
		t.Fatalf("err = %+v, want %s of %s", de, problem, dir)
	}
}

func perm(t *testing.T, path string) fs.FileMode {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

// The directory is made 0700 when it is missing, and used again when it is there.
func TestSocketDirMakesAndReuses(t *testing.T) {
	for _, xdg := range []bool{true, false} {
		want := socketDirIn(t, t.TempDir(), xdg)
		for i := 0; i < 2; i++ {
			dir, err := SocketDir("", true)
			if err != nil {
				t.Fatalf("xdg=%v, call %d: %v", xdg, i, err)
			}
			if dir != want {
				t.Fatalf("dir = %s, want %s", dir, want)
			}
			if p := perm(t, dir); p != 0o700 {
				t.Fatalf("permission = %04o", p)
			}
		}
		if sock, err := ServeSocketPath(""); err != nil || sock != filepath.Join(want, "serve.rpc") {
			t.Fatalf("ServeSocketPath = %s, %v", sock, err)
		}
	}
}

// A directory that XDG_RUNTIME_DIR names but that is not there is made too.
func TestSocketDirMakesTheDirectoryAbove(t *testing.T) {
	want := socketDirIn(t, filepath.Join(t.TempDir(), "run", "user"), true)
	dir, err := SocketDir("", true)
	if err != nil || dir != want {
		t.Fatalf("SocketDir = %s, %v", dir, err)
	}
}

// Without create nothing is made and nothing is checked.
func TestSocketDirWithoutCreate(t *testing.T) {
	want := socketDirIn(t, t.TempDir(), true)
	dir, err := SocketDir("", false)
	if err != nil || dir != want {
		t.Fatalf("SocketDir = %s, %v", dir, err)
	}
	if _, err := os.Lstat(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the directory was made: %v", err)
	}
}

// A symbolic link in the place of the directory is refused, also when it
// points at a private directory of this user, and also when it points nowhere.
func TestSocketDirRefusesSymlink(t *testing.T) {
	for _, xdg := range []bool{true, false} {
		for _, dangling := range []bool{false, true} {
			dir := socketDirIn(t, t.TempDir(), xdg)
			target := filepath.Join(t.TempDir(), "target")
			if !dangling {
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, dir); err != nil {
				t.Fatal(err)
			}
			_, err := SocketDir("", true)
			wantProblem(t, err, dir, SocketDirSymlink)
			if _, err := ServeSocketPath(""); err == nil {
				t.Fatal("ServeSocketPath used the symbolic link")
			}
			if _, err := os.Lstat(target); dangling != errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("dangling=%v, the target after the call: %v", dangling, err)
			}
		}
	}
}

// A directory that other users can enter is refused, and its permission is
// left as it was.
func TestSocketDirRefusesOtherPermission(t *testing.T) {
	for _, mode := range []fs.FileMode{0o755, 0o777, 0o750, 0o500} {
		dir := socketDirIn(t, t.TempDir(), true)
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, mode); err != nil { // Mkdir's mode goes through the umask
			t.Fatal(err)
		}
		_, err := SocketDir("", true)
		wantProblem(t, err, dir, SocketDirMode)
		if p := perm(t, dir); p != mode {
			t.Fatalf("permission changed from %04o to %04o", mode, p)
		}
	}
}

func TestSocketDirRefusesFile(t *testing.T) {
	dir := socketDirIn(t, t.TempDir(), true)
	if err := os.WriteFile(dir, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := SocketDir("", true)
	wantProblem(t, err, dir, SocketDirNotDir)
}

// A directory of another user is refused. "/" belongs to root wherever the
// tests are not run as the owner of "/".
func TestCheckSocketDirRefusesOtherOwner(t *testing.T) {
	fi, err := os.Lstat("/")
	if err != nil {
		t.Fatal(err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid == uint32(os.Getuid()) {
		t.Skip("/ belongs to the user of the test")
	}
	wantProblem(t, CheckSocketDir("/"), "/", SocketDirOwner)
}

func TestCheckSocketDirMissing(t *testing.T) {
	if err := CheckSocketDir(filepath.Join(t.TempDir(), "none")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v", err)
	}
}

// The text of every problem names the directory, in both languages.
func TestSocketDirErrorText(t *testing.T) {
	t.Cleanup(func() { i18n.SetLang(i18n.Default) })
	for _, lang := range []string{i18n.English, i18n.Japanese} {
		i18n.SetLang(lang)
		for _, e := range []*SocketDirError{
			{Dir: "/tmp/shijimi-1", Problem: SocketDirSymlink},
			{Dir: "/tmp/shijimi-1", Problem: SocketDirNotDir},
			{Dir: "/tmp/shijimi-1", Problem: SocketDirOwner, Owner: 4242},
			{Dir: "/tmp/shijimi-1", Problem: SocketDirMode, Mode: 0o755},
		} {
			text := e.Error()
			if !strings.Contains(text, e.Dir) || strings.Contains(text, "%!") || strings.Contains(text, "socketdir.") {
				t.Errorf("%s, %s: %q", lang, e.Problem, text)
			}
			if e.Problem == SocketDirOwner && !strings.Contains(text, "4242") {
				t.Errorf("%s: the owner is not in %q", lang, text)
			}
			if e.Problem == SocketDirMode && !strings.Contains(text, "0755") {
				t.Errorf("%s: the permission is not in %q", lang, text)
			}
		}
	}
}
