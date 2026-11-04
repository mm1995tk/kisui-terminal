package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/mm1995tk/shijimi-editor/core/ctl"
	"github.com/mm1995tk/shijimi-editor/core/i18n"
	"github.com/mm1995tk/shijimi-editor/ui/gui/attach"
)

// runAttach is "shj attach": the bridge between stdin/stdout and the socket of
// "shj serve", which it starts (detached) when it is not running. It returns
// the process exit code.
func runAttach(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("attach.usage"))
		return 2
	}
	sock, err := ctl.ServeSocketPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	lock, err := ctl.ServeLockPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// serve's standard error is kept in a file while attach waits for it, so that
	// the reason it could not start (a mistake in a configuration file) reaches
	// the GUI as attach's own standard error.
	proc := &serveProc{}
	defer proc.cleanup()
	err = attach.Run(attach.Options{
		SocketPath: sock,
		LockPath:   lock,
		Start:      proc.start,
		Exited:     proc.exited,
		In:         os.Stdin,
		Out:        os.Stdout,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// serveProc is the "shj serve" that attach started.
type serveProc struct {
	done chan struct{} // closed when the process ended
	errf string        // the file its standard error goes to
}

// start runs "shj serve" from this same executable, in its own session,
// with stdin/stdout closed (/dev/null). serve writes its own log file; its
// standard error goes to a temporary file that exited reads.
func (p *serveProc) start() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	// A file, not a pipe: serve outlives attach, and a write to a pipe nobody
	// reads any more would kill it.
	errf, err := os.CreateTemp("", "shj-serve-*.err")
	if err != nil {
		return err
	}
	defer errf.Close()
	p.errf = errf.Name()
	cmd := exec.Command(exe, "serve")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, errf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.done = make(chan struct{})
	go func() {
		cmd.Wait()
		close(p.done)
	}()
	return nil
}

// exited reports whether the serve that start ran has ended, and what it said.
func (p *serveProc) exited() (string, bool) {
	if p.done == nil {
		return "", false
	}
	select {
	case <-p.done:
		b, _ := os.ReadFile(p.errf)
		if msg := strings.TrimSpace(string(b)); msg != "" {
			return msg, true
		}
		return i18n.T("serve.failed"), true
	default:
		return "", false
	}
}

// cleanup removes the temporary file. serve keeps writing to it if it runs.
func (p *serveProc) cleanup() {
	if p.errf != "" {
		os.Remove(p.errf)
	}
}
