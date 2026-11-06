// Package term runs a shell on a PTY. It is the part of the terminal that has
// neither a screen nor a front end: the TUI feeds the output to its emulator
// (ui/tui/vt) and draws it, `kisui serve` relays it to coneko-term. Neither
// bubbletea nor lipgloss nor terminal cell widths come in here.
// See docs/design/gui-protocol.md.
package term

import (
	"io"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// DefaultShell is $SHELL, or /bin/sh when it is not set.
func DefaultShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

// Options say how to start a shell.
type Options struct {
	Shell string   // "" for DefaultShell
	Args  []string // arguments of the shell
	Dir   string   // working directory; "" for the caller's
	Env   []string // KEY=value entries added after the caller's environment and TERM
	Cols  int      // size of the PTY; at least 1
	Rows  int
}

// Session is a shell running on its own PTY.
type Session struct {
	ptmx *os.File
	cmd  *exec.Cmd
}

// Start runs a shell on a fresh PTY. The caller's environment is passed on
// with TERM and COLORTERM set for a full-color terminal, then Options.Env.
func Start(o Options) (*Session, error) {
	sh := o.Shell
	if sh == "" {
		sh = DefaultShell()
	}
	cmd := exec.Command(sh, o.Args...)
	cmd.Dir = o.Dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	cmd.Env = append(cmd.Env, o.Env...)
	ptmx, err := pty.StartWithSize(cmd, winsize(o.Cols, o.Rows))
	if err != nil {
		return nil, err
	}
	return &Session{ptmx: ptmx, cmd: cmd}, nil
}

func winsize(cols, rows int) *pty.Winsize {
	return &pty.Winsize{Rows: uint16(max(1, rows)), Cols: uint16(max(1, cols))}
}

// Write sends bytes to the shell as if they were typed. A Session is an
// io.Writer so an emulator can answer the program's queries through it.
func (s *Session) Write(p []byte) (int, error) { return s.ptmx.Write(p) }

var _ io.Writer = (*Session)(nil)

// Read reads what the shell printed.
func (s *Session) Read(p []byte) (int, error) { return s.ptmx.Read(p) }

// Resize tells the shell the PTY is now cols x rows cells.
func (s *Session) Resize(cols, rows int) error {
	return pty.Setsize(s.ptmx, winsize(cols, rows))
}

// Pump passes everything the shell prints to sink, until the PTY closes, and
// then waits for the shell. It returns what Wait returns. sink is called from
// this goroutine, one chunk at a time; the slice is reused.
func (s *Session) Pump(sink func([]byte)) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			sink(buf[:n])
		}
		if err != nil {
			break
		}
	}
	return s.cmd.Wait()
}

// Close closes the PTY, which hangs up the shell's session, and kills the
// shell if it is still there.
func (s *Session) Close() {
	s.ptmx.Close()
	if s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
}

// Pid is the shell's process ID.
func (s *Session) Pid() int { return s.cmd.Process.Pid }

// File is the master side of the PTY. `kisui serve` reads it itself so it can
// keep its ring buffer and flow control between the shell and the GUI.
func (s *Session) File() *os.File { return s.ptmx }

// Cmd is the shell's process.
func (s *Session) Cmd() *exec.Cmd { return s.cmd }
