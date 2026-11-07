package term

import (
	"os/exec"
	"strings"
	"sync"
	"testing"
)

func TestSessionRunsShellAndReportsExit(t *testing.T) {
	s, err := Start(Options{Shell: "/bin/sh", Args: []string{"-c", "echo $FOO-$TERM; exit 3"}, Env: []string{"FOO=bar"}, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var mu sync.Mutex
	var out strings.Builder
	err = s.Pump(func(b []byte) { mu.Lock(); out.Write(b); mu.Unlock() })
	if err == nil || !strings.Contains(err.Error(), "exit status 3") {
		t.Errorf("Pump err = %v, want exit status 3", err)
	}
	if got := out.String(); !strings.Contains(got, "bar-xterm-256color") {
		t.Errorf("output = %q", got)
	}
}

func TestSessionWriteAndResize(t *testing.T) {
	s, err := Start(Options{Shell: "/bin/sh", Args: []string{"-c", "read x; stty size; echo got-$x"}, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Resize(70, 20); err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("hi\n"))
	var out strings.Builder
	s.Pump(func(b []byte) { out.Write(b) })
	if got := out.String(); !strings.Contains(got, "20 70") || !strings.Contains(got, "got-hi") {
		t.Errorf("output = %q", got)
	}
}

func TestStartFailsForMissingShell(t *testing.T) {
	if _, err := Start(Options{Shell: "/no/such/shell"}); err == nil {
		t.Error("want an error")
	}
}

// term is shared by the TUI and the GUI server, so it must not know either.
func TestNoTerminalDeps(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}
	for dep := range strings.FieldsSeq(string(out)) {
		for _, banned := range []string{"charm.land/", "github.com/charmbracelet/", "github.com/mm1995tk/shijimi-editor/"} {
			if strings.HasPrefix(dep, banned) {
				t.Errorf("internal/term depends on %s", dep)
			}
		}
	}
}

func TestWithLocale(t *testing.T) {
	ja := func() string { return "ja_JP\n" }
	yes := func(string) bool { return true }
	no := func(string) bool { return false }
	cases := []struct {
		name string
		env  []string
		goos string
		ex   func(string) bool
		want string // "" for unchanged
	}{
		{"unset", []string{"A=b"}, "darwin", yes, "LANG=ja_JP.UTF-8"},
		{"missing locale", nil, "darwin", no, "LANG=en_US.UTF-8"},
		{"LANG set", []string{"LANG=C"}, "darwin", yes, ""},
		{"LC_ALL set", []string{"LC_ALL=en_US.UTF-8"}, "darwin", yes, ""},
		{"LC_CTYPE set", []string{"LC_CTYPE=UTF-8"}, "darwin", yes, ""},
		{"linux", nil, "linux", yes, ""},
	}
	for _, c := range cases {
		got := withLocale(c.env, c.goos, ja, c.ex)
		if c.want == "" {
			if len(got) != len(c.env) {
				t.Errorf("%s: changed: %v", c.name, got)
			}
			continue
		}
		if got[len(got)-1] != c.want {
			t.Errorf("%s: got %v, want %s", c.name, got, c.want)
		}
	}
}
