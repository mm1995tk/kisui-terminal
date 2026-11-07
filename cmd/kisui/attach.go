package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/mm1995tk/kisui-terminal/attach"
	"github.com/mm1995tk/kisui-terminal/internal/buildinfo"
	"github.com/mm1995tk/kisui-terminal/internal/ctl"
	"github.com/mm1995tk/kisui-terminal/internal/i18n"
	"github.com/mm1995tk/kisui-terminal/server"
)

// runAttach is "kisui attach": the bridge between stdin/stdout and the socket of
// "kisui serve", which it starts (detached) when it is not running. It returns
// the process exit code.
func runAttach(args []string) int {
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, i18n.T("attach.usage"))
		return 2
	}
	sock, err := ctl.ServeSocketPath(buildinfo.Suffix())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	lock, err := ctl.ServeLockPath(buildinfo.Suffix())
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
		Info:       attachInfo(),
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

// attachInfo is what attach tells the GUI about itself (attach.info): the
// executable and version of this kisui, which the GUI compares with the running
// serve's and passes to server.handover when they differ. It is nil when the
// executable cannot be found; the GUI then does not ask for a handover.
func attachInfo() *attach.Info {
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	ver, commit := buildinfo.Resolve()
	info := &attach.Info{Executable: exe, Version: ver, Commit: commit, Channel: channelName()}
	// The new serve drops the old serve's KISUI_SHJ_DIR (it points at the old
	// shj); the one this attach was given points at the shj of its own version.
	if dir := os.Getenv(server.EnvShjDir); dir != "" {
		info.Env = map[string]string{server.EnvShjDir: dir}
	}
	return info
}

// channelName is the channel as session.hello and attach.info name it.
func channelName() string {
	if buildinfo.IsNightly() {
		return buildinfo.Nightly
	}
	return "stable"
}

// serveProc is the "kisui serve" that attach started.
type serveProc struct {
	done chan struct{} // closed when the process ended
	errf string        // the file its standard error goes to
}

// start runs "kisui serve" from this same executable, in its own session,
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
	errf, err := os.CreateTemp("", "kisui-serve-*.err")
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
