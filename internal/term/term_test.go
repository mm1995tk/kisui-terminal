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
