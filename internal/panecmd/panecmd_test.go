package panecmd

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
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
	p := Pane{Socket: filepath.Join(t.TempDir(), "none.rpc"), ID: "t1", Token: "x"}
	_, err := p.Do(Request{Cmd: "open", Target: "https://example.com/"})
	if !errors.Is(err, ErrNoServer) || strings.Contains(err.Error(), ErrNoServer.Error()) {
		t.Fatalf("err: %v", err)
	}
}
