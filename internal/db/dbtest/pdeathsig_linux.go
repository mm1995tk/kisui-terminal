package dbtest

import (
	"os/exec"
	"syscall"
)

// dieWithParent makes the server end when the test binary dies without
// calling Stop (a test timeout, a panic).
func dieWithParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
