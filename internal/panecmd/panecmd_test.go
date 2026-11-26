package panecmd

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mm1995tk/kisui-terminal/internal/ctl"
)

func TestHasScheme(t *testing.T) {
	for s, want := range map[string]bool{
		"https://example.com": true,
		"http://x":            true,
		"ftp://x":             true,
		"a.png":               false,
		"./a://b":             false,
		"/tmp/x://y":          false,
		"a.b://c":             false,
		"://x":                false,
	} {
		if got := HasScheme(s); got != want {
			t.Errorf("HasScheme(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv(EnvSocket, "/s")
	t.Setenv(EnvPane, "t1")
	t.Setenv(EnvToken, "")
	if _, err := FromEnv(); err != ErrNotInPane {
		t.Fatalf("without a secret: %v", err)
	}
	t.Setenv(EnvToken, "x")
	if p, err := FromEnv(); err != nil || p != (Pane{Socket: "/s", ID: "t1", Token: "x"}) {
		t.Fatalf("%+v %v", p, err)
	}
}

// When the socket does not answer, the error is ErrNoServer and its text is the
// one of the dial only (the message around it says that kisui serve is not running).
func TestDoWithoutServer(t *testing.T) {
	dir := socketDir(t)
	for _, sock := range []string{
		filepath.Join(dir, "none.rpc"),         // no socket in the directory
		filepath.Join(dir, "gone", "none.rpc"), // no directory
	} {
		p := Pane{Socket: sock, ID: "t1", Token: "x"}
		_, err := p.Do(Request{Cmd: "open", Target: "https://example.com/"})
		if !errors.Is(err, ErrNoServer) || strings.Contains(err.Error(), ErrNoServer.Error()) {
			t.Fatalf("%s: err: %v", sock, err)
		}
	}
}

// socketDir is a private (0700) folder with a short path: the path of a Unix
// socket may be at most about 100 bytes, and t.TempDir can be longer.
func socketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// serveOnce listens on sock and answers every request with reply. The channel
// gets the requests that came.
func serveOnce(t *testing.T, sock string, reply Reply) <-chan Request {
	t.Helper()
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan Request, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			var rq Request
			if json.NewDecoder(c).Decode(&rq) == nil {
				got <- rq
				_ = json.NewEncoder(c).Encode(reply)
			}
			c.Close()
		}
	}()
	return got
}

// In a private directory of this user, Do sends the request with the id and
// the secret of the pane and returns the reply.
func TestDoInPrivateDir(t *testing.T) {
	sock := filepath.Join(socketDir(t), "serve-primary.rpc")
	got := serveOnce(t, sock, Reply{OK: true, ID: "t7"})
	r, err := Pane{Socket: sock, ID: "t1", Token: "x"}.Do(Request{Cmd: "split", Dir: "right"})
	if err != nil || r.ID != "t7" {
		t.Fatalf("reply %+v, err %v", r, err)
	}
	if rq := <-got; rq.Cmd != "split" || rq.Pane != "t1" || rq.Token != "x" {
		t.Fatalf("request %+v", rq)
	}
}

// Do connects to nothing when the directory of the socket is not a private
// directory of this user: the secret of the pane is not sent to a socket that
// another user may have put there.
func TestDoRefusesOtherSocketDir(t *testing.T) {
	t.Run("permission", func(t *testing.T) {
		dir := socketDir(t)
		sock := filepath.Join(dir, "serve-primary.rpc")
		got := serveOnce(t, sock, Reply{OK: true})
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		wantRefused(t, sock, got, ctl.SocketDirMode)
	})
	t.Run("symlink", func(t *testing.T) {
		dir := socketDir(t)
		got := serveOnce(t, filepath.Join(dir, "serve-primary.rpc"), Reply{OK: true})
		link := filepath.Join(socketDir(t), "link")
		if err := os.Symlink(dir, link); err != nil {
			t.Fatal(err)
		}
		wantRefused(t, filepath.Join(link, "serve-primary.rpc"), got, ctl.SocketDirSymlink)
	})
	t.Run("file", func(t *testing.T) {
		file := filepath.Join(socketDir(t), "file")
		if err := os.WriteFile(file, nil, 0o700); err != nil {
			t.Fatal(err)
		}
		wantRefused(t, filepath.Join(file, "serve-primary.rpc"), nil, ctl.SocketDirNotDir)
	})
}

// wantRefused fails unless Do on sock is refused for problem, is not taken
// for a server that is not running, and no request reached got.
func wantRefused(t *testing.T, sock string, got <-chan Request, problem string) {
	t.Helper()
	_, err := Pane{Socket: sock, ID: "t1", Token: "x"}.Do(Request{Cmd: "list"})
	var de *ctl.SocketDirError
	if !errors.As(err, &de) || de.Problem != problem || de.Dir != filepath.Dir(sock) {
		t.Fatalf("err = %v, want %s", err, problem)
	}
	if errors.Is(err, ErrNoServer) {
		t.Fatalf("taken for a server that is not running: %v", err)
	}
	select {
	case rq := <-got:
		t.Fatalf("a request was sent: %+v", rq)
	default:
	}
}
